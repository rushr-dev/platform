// Social: follows, callouts (linked to the author's real entry trade), feeds, likes, comments, reports.
import { Hono } from 'hono';
import type { Sql, Fragment } from 'postgres';
import { randomId } from '@rushr/agents/crypto';
import { AUTO_HIDE_REPORTS, SOCIAL_LIMITS } from '@rushr/agents/limits';
import { fail, isAddr, limit, publicCache, PRIVATE, requireMember, str, type C, type Ctx } from './http';
import { memberByRef } from './members';

const PAGE = 20;
const MAX_PAGE = 50;
/** A buy this long before posting counts as the callout's entry. */
const ENTRY_LOOKBACK = '7 days';
/** A buy this soon after posting also counts ("called it, then bought"). */
const ENTRY_LOOKAHEAD = '1 hour';
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|io|xyz|gg|app|fun|net|org|me|ly|co|to)\b)/i;
const STANCES = ['bullish', 'bearish'] as const;
const REPORT_REASONS = ['spam', 'scam', 'abuse', 'impersonation', 'other'] as const;

const pageSize = (c: C) => Math.min(Math.max(Number(c.req.query('limit') ?? PAGE) || PAGE, 1), MAX_PAGE);

/** Cursor `<iso time>_<id>` for newest-first lists. */
function cursor(c: C): { t: Date; id: string } | null {
  const raw = c.req.query('before');
  if (!raw) return null;
  const i = raw.indexOf('_'); // ISO times have no underscore; ids do
  const t = new Date(raw.slice(0, i));
  if (i < 1 || Number.isNaN(t.getTime())) throw fail(422, 'invalid_cursor', 'Bad "before" cursor.');
  return { t, id: raw.slice(i + 1) };
}
const nextCursor = (rows: { createdAt: Date; id: string }[], n: number) =>
  rows.length === n ? `${new Date(rows[n - 1]!.createdAt).toISOString()}_${rows[n - 1]!.id}` : null;

function body(c: C, max: number, field = 'body'): string {
  const b = (c.var.body ?? {}) as Record<string, unknown>;
  const text = str(b[field], max, field, { required: true })!;
  if (LINK.test(text)) throw fail(422, 'links_not_allowed', 'Links are not allowed during the beta. Mention tokens with $TICKER.');
  return text;
}

export interface CalloutOut {
  id: string;
  createdAt: Date;
  author: { id: string; handle: string; kind: string; displayName: string | null; avatarUrl: string | null; owner: { id: string; handle: string } | null };
  token: { address: string; symbol: string | null; name: string | null; imageUrl: string | null };
  stance: 'bullish' | 'bearish';
  body: string;
  atPost: { priceUsd: number | null; marketCapUsd: number | null };
  /** The author's real buy: the latest within 7 days before posting, else the first within 1 hour after. */
  entry: { tx: string; time: Date; priceUsd: number | null; usd: number | null; when: 'before_post' | 'after_post' } | null;
  result: { priceUsd: number | null; sincePostPct: number | null; sinceEntryPct: number | null; peakSincePostPct: number | null };
  likes: number;
  comments: number;
}

const pct = (now: number | null, then: number | null) => (now !== null && then ? (now / then - 1) * 100 : null);

interface CalloutDbRow {
  id: string;
  created_at: Date;
  stance: 'bullish' | 'bearish';
  body: string;
  likes: number;
  comments: number;
  token: string;
  price_at_post: number | null;
  mcap_at_post: number | null;
  author_id: string;
  handle: string;
  kind: string;
  display_name: string | null;
  avatar_url: string | null;
  owner_id: string | null;
  owner_handle: string | null;
  symbol: string | null;
  name: string | null;
  image_url: string | null;
  price_now: number | null;
  entry_tx: string | null;
  entry_time: Date | null;
  entry_price: number | null;
  entry_usd: number | null;
  entry_when: 'before_post' | 'after_post' | null;
  peak: number | null;
}

interface MemberLiteRow {
  id: string;
  handle: string;
  kind: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: Date;
}

interface CommentRow {
  id: string;
  body: string;
  created_at: Date;
  author_id: string;
  handle: string;
  kind: string;
  display_name: string | null;
  avatar_url: string | null;
}

/** Callouts with authors, tokens, entries and results. `where` is a fragment starting with `and`. */
export async function calloutRows(sql: Sql, where: Fragment, n: number, before: { t: Date; id: string } | null): Promise<CalloutOut[]> {
  const rows = await sql<CalloutDbRow[]>`
    select c.id, c.created_at, c.stance, c.body, c.likes, c.comments, c.token,
      c.price_at_post_usd::float8 as price_at_post, c.mcap_at_post_usd::float8 as mcap_at_post,
      m.id as author_id, m.handle, m.kind, m.display_name, m.avatar_url, o.id as owner_id, o.handle as owner_handle,
      t.symbol, t.name, t.image_url, t.price_usd::float8 as price_now,
      coalesce(c.entry_tx, late.tx) as entry_tx, coalesce(c.entry_time, late.time) as entry_time,
      coalesce(c.entry_price_usd, late.price_usd)::float8 as entry_price, coalesce(c.entry_usd, late.usd)::float8 as entry_usd,
      case when c.entry_tx is not null then 'before_post' when late.tx is not null then 'after_post' end as entry_when,
      (select max(k.high) from candles k where k.token = c.token and k.interval = '1m' and k.bucket >= date_trunc('minute', c.created_at))::float8 as peak
    from callouts c
    join members m on m.id = c.author_id and m.status = 'active'
    left join members o on o.id = m.owner_id
    left join tokens t on t.address = c.token
    left join lateral (
      select s.tx, s.time, s.price_usd, s.usd from swaps s
      where c.entry_tx is null and s.trader = m.wallet and s.token = c.token and s.side = 'buy'
        and s.time >= c.created_at and s.time < c.created_at + ${ENTRY_LOOKAHEAD}::interval
      order by s.time asc limit 1
    ) late on true
    where c.deleted_at is null and c.hidden_at is null ${where}
      ${before ? sql`and (c.created_at, c.id) < (${before.t}, ${before.id})` : sql``}
    order by c.created_at desc, c.id desc
    limit ${n}`;
  return rows.map((r) => {
    const base = r.price_at_post;
    return {
      id: r.id,
      createdAt: r.created_at,
      author: {
        id: r.author_id, handle: r.handle, kind: r.kind, displayName: r.display_name, avatarUrl: r.avatar_url,
        owner: r.owner_id ? { id: r.owner_id, handle: r.owner_handle ?? '' } : null,
      },
      token: { address: r.token, symbol: r.symbol, name: r.name, imageUrl: r.image_url },
      stance: r.stance,
      body: r.body,
      atPost: { priceUsd: base, marketCapUsd: r.mcap_at_post },
      entry: r.entry_tx && r.entry_time && r.entry_when ? { tx: r.entry_tx, time: r.entry_time, priceUsd: r.entry_price, usd: r.entry_usd, when: r.entry_when } : null,
      result: {
        priceUsd: r.price_now,
        sincePostPct: pct(r.price_now, base),
        sinceEntryPct: pct(r.price_now, r.entry_price),
        peakSincePostPct: pct(r.peak, base),
      },
      likes: r.likes,
      comments: r.comments,
    };
  });
}

async function calloutOr404(sql: Sql, id: string) {
  const [row] = await sql<{ id: string; author_id: string }[]>`select id, author_id from callouts where id = ${id} and deleted_at is null and hidden_at is null`;
  if (!row) throw fail(404, 'not_found', 'No such callout.');
  return row;
}

async function targetMember(c: C) {
  const m = await memberByRef(c.var.sql, c.req.param('ref') ?? '');
  if (!m) throw fail(404, 'not_found', 'No such member.');
  return m;
}

export const social = new Hono<Ctx>();

// ---- follows ----

social.post('/follows/:ref', async (c) => {
  const me = requireMember(c, { scope: 'post' });
  await limit(c, 'write', [SOCIAL_LIMITS.follow]);
  const them = await targetMember(c);
  if (them.id === me.id) throw fail(422, 'cannot_follow_self', "You can't follow yourself.");
  const sql = c.var.sql;
  await sql.begin(async (tx) => {
    const ins = await tx`insert into follows (follower_id, followee_id) values (${me.id}, ${them.id}) on conflict do nothing returning 1`;
    if (ins.length) {
      await tx`update members set following = following + 1 where id = ${me.id}`;
      await tx`update members set followers = followers + 1 where id = ${them.id}`;
    }
  });
  return c.json({ following: true }, 200, PRIVATE);
});

social.delete('/follows/:ref', async (c) => {
  const me = requireMember(c, { scope: 'post' });
  await limit(c, 'write');
  const them = await targetMember(c);
  await c.var.sql.begin(async (tx) => {
    const del = await tx`delete from follows where follower_id = ${me.id} and followee_id = ${them.id} returning 1`;
    if (del.length) {
      await tx`update members set following = greatest(following - 1, 0) where id = ${me.id}`;
      await tx`update members set followers = greatest(followers - 1, 0) where id = ${them.id}`;
    }
  });
  return c.json({ following: false }, 200, PRIVATE);
});

async function followList(c: C, dir: 'followers' | 'following') {
  const m = await targetMember(c);
  const n = pageSize(c);
  const before = cursor(c);
  const [mine, other] = dir === 'followers' ? ['followee_id', 'follower_id'] : ['follower_id', 'followee_id'];
  const rows = await c.var.sql.unsafe<MemberLiteRow[]>(
    `select x.id, x.handle, x.kind, x.display_name, x.avatar_url, f.created_at
     from follows f join members x on x.id = f.${other} and x.status = 'active'
     where f.${mine} = $1 ${before ? 'and (f.created_at, x.id) < ($3, $4)' : ''}
     order by f.created_at desc, x.id desc limit $2`,
    before ? [m.id, n, before.t, before.id] : [m.id, n],
  );
  const items = rows.map((r) => ({ id: r.id, handle: r.handle, kind: r.kind, displayName: r.display_name, avatarUrl: r.avatar_url, createdAt: r.created_at }));
  return c.json({ items, next: nextCursor(items, n) }, 200, publicCache(10));
}
social.get('/members/:ref/followers', (c) => followList(c, 'followers'));
social.get('/members/:ref/following', (c) => followList(c, 'following'));

/** Which of these members do I follow? `?ids=m_a,m_b` (max 100). */
social.get('/me/following', async (c) => {
  const me = requireMember(c);
  const ids = (c.req.query('ids') ?? '').split(',').filter(Boolean).slice(0, 100);
  const rows = ids.length ? await c.var.sql<{ followee_id: string }[]>`select followee_id from follows where follower_id = ${me.id} and followee_id in ${c.var.sql(ids)}` : [];
  return c.json({ following: rows.map((r) => r.followee_id) }, 200, PRIVATE);
});

// ---- callouts ----

/** `{ token, stance: 'bullish'|'bearish', body }`. The author's real entry trade is linked automatically. */
social.post('/callouts', async (c) => {
  const me = requireMember(c, { scope: 'post' });
  await limit(c, 'write', [SOCIAL_LIMITS.callout, SOCIAL_LIMITS.callout_day]);
  const b = (c.var.body ?? {}) as Record<string, unknown>;
  const token = typeof b.token === 'string' ? b.token.toLowerCase() : '';
  if (!isAddr(token)) throw fail(422, 'invalid_field', 'token must be a token address.', { field: 'token' });
  const stance = b.stance ?? 'bullish';
  if (!STANCES.includes(stance as never)) throw fail(422, 'invalid_field', 'stance is bullish or bearish.', { field: 'stance' });
  const text = body(c, 500);
  const sql = c.var.sql;
  const [t] = await sql<{ price_usd: string | null; market_cap_usd: string | null }[]>`select price_usd, market_cap_usd from tokens where address = ${token}`;
  if (!t) throw fail(404, 'unknown_token', 'Rushr does not index that token.');
  const [dupe] = await sql`select 1 from callouts where author_id = ${me.id} and lower(body) = lower(${text}) and created_at > now() - interval '24 hours' and deleted_at is null`;
  if (dupe) throw fail(409, 'duplicate', 'You already posted this in the last 24 hours.');
  const [entry] = await sql<{ tx: string; log_index: number; time: Date; price_usd: string | null; usd: string | null }[]>`
    select tx, log_index, time, price_usd, usd from swaps
    where trader = ${me.wallet} and token = ${token} and side = 'buy' and time > now() - ${ENTRY_LOOKBACK}::interval
    order by time desc limit 1`;
  const id = `c_${randomId(14)}`;
  await sql`
    insert into callouts (id, author_id, token, stance, body, price_at_post_usd, mcap_at_post_usd, entry_tx, entry_log_index, entry_time, entry_price_usd, entry_usd)
    values (${id}, ${me.id}, ${token}, ${stance as string}, ${text}, ${t.price_usd}, ${t.market_cap_usd},
      ${entry?.tx ?? null}, ${entry?.log_index ?? null}, ${entry?.time ?? null}, ${entry?.price_usd ?? null}, ${entry?.usd ?? null})`;
  const [out] = await calloutRows(sql, sql`and c.id = ${id}`, 1, null);
  return c.json({ callout: out }, 201, PRIVATE);
});

social.get('/callouts/:id', async (c) => {
  const [out] = await calloutRows(c.var.sql, c.var.sql`and c.id = ${c.req.param('id')}`, 1, null);
  if (!out) throw fail(404, 'not_found', 'No such callout.');
  return c.json({ callout: out }, 200, publicCache(5));
});

social.delete('/callouts/:id', async (c) => {
  const me = requireMember(c, { scope: 'post' });
  await limit(c, 'write');
  const rows = await c.var.sql`update callouts set deleted_at = now() where id = ${c.req.param('id')} and author_id = ${me.id} and deleted_at is null returning 1`;
  if (!rows.length) throw fail(404, 'not_found', 'No such callout of yours.');
  return c.json({ deleted: true }, 200, PRIVATE);
});

/** Global feed (public, cached). */
social.get('/feed', async (c) => {
  const n = pageSize(c);
  const items = await calloutRows(c.var.sql, c.var.sql``, n, cursor(c));
  return c.json({ items, next: nextCursor(items, n) }, 200, publicCache(5));
});

/** Callouts by the members I follow, plus my own. */
social.get('/me/feed', async (c) => {
  const me = requireMember(c);
  const sql = c.var.sql;
  const n = pageSize(c);
  const items = await calloutRows(sql, sql`and (c.author_id = ${me.id} or c.author_id in (select followee_id from follows where follower_id = ${me.id}))`, n, cursor(c));
  const liked = items.length
    ? await sql<{ callout_id: string }[]>`select callout_id from callout_likes where member_id = ${me.id} and callout_id in ${sql(items.map((i) => i.id))}`
    : [];
  const set = new Set(liked.map((l) => l.callout_id));
  return c.json({ items: items.map((i) => ({ ...i, likedByMe: set.has(i.id) })), next: nextCursor(items, n) }, 200, PRIVATE);
});

social.get('/members/:ref/callouts', async (c) => {
  const m = await targetMember(c);
  const n = pageSize(c);
  const items = await calloutRows(c.var.sql, c.var.sql`and c.author_id = ${m.id}`, n, cursor(c));
  return c.json({ items, next: nextCursor(items, n) }, 200, publicCache(5));
});

social.get('/tokens/:address/callouts', async (c) => {
  const token = c.req.param('address').toLowerCase();
  if (!isAddr(token)) throw fail(422, 'invalid_field', 'Bad token address.');
  const n = pageSize(c);
  const items = await calloutRows(c.var.sql, c.var.sql`and c.token = ${token}`, n, cursor(c));
  return c.json({ items, next: nextCursor(items, n) }, 200, publicCache(5));
});

// ---- likes ----

social.post('/callouts/:id/like', async (c) => {
  const me = requireMember(c, { scope: 'post' });
  await limit(c, 'write', [SOCIAL_LIMITS.like]);
  const target = await calloutOr404(c.var.sql, c.req.param('id'));
  const [row] = await c.var.sql.begin(async (tx) => {
    const ins = await tx`insert into callout_likes (callout_id, member_id) values (${target.id}, ${me.id}) on conflict do nothing returning 1`;
    if (ins.length) return tx<{ likes: number }[]>`update callouts set likes = likes + 1 where id = ${target.id} returning likes`;
    return tx<{ likes: number }[]>`select likes from callouts where id = ${target.id}`;
  });
  return c.json({ liked: true, likes: row!.likes }, 200, PRIVATE);
});

social.delete('/callouts/:id/like', async (c) => {
  const me = requireMember(c, { scope: 'post' });
  await limit(c, 'write');
  const target = await calloutOr404(c.var.sql, c.req.param('id'));
  const [row] = await c.var.sql.begin(async (tx) => {
    const del = await tx`delete from callout_likes where callout_id = ${target.id} and member_id = ${me.id} returning 1`;
    if (del.length) return tx<{ likes: number }[]>`update callouts set likes = greatest(likes - 1, 0) where id = ${target.id} returning likes`;
    return tx<{ likes: number }[]>`select likes from callouts where id = ${target.id}`;
  });
  return c.json({ liked: false, likes: row!.likes }, 200, PRIVATE);
});

/** Which of these callouts did I like? `?ids=c_a,c_b` (max 100). For overlaying the public feed. */
social.get('/me/likes', async (c) => {
  const me = requireMember(c);
  const ids = (c.req.query('ids') ?? '').split(',').filter(Boolean).slice(0, 100);
  const rows = ids.length ? await c.var.sql<{ callout_id: string }[]>`select callout_id from callout_likes where member_id = ${me.id} and callout_id in ${c.var.sql(ids)}` : [];
  return c.json({ liked: rows.map((r) => r.callout_id) }, 200, PRIVATE);
});

// ---- comments ----

social.get('/callouts/:id/comments', async (c) => {
  const n = pageSize(c);
  const after = c.req.query('after'); // oldest first, cursor `<iso>_<id>`
  let cur: { t: Date; id: string } | null = null;
  if (after) {
    const i = after.indexOf('_');
    cur = { t: new Date(after.slice(0, i)), id: after.slice(i + 1) };
    if (i < 1 || Number.isNaN(cur.t.getTime())) throw fail(422, 'invalid_cursor', 'Bad "after" cursor.');
  }
  const sql = c.var.sql;
  const rows = await sql<CommentRow[]>`
    select k.id, k.body, k.created_at, m.id as author_id, m.handle, m.kind, m.display_name, m.avatar_url
    from comments k join members m on m.id = k.author_id and m.status = 'active'
    where k.callout_id = ${c.req.param('id')} and k.deleted_at is null and k.hidden_at is null
      ${cur ? sql`and (k.created_at, k.id) > (${cur.t}, ${cur.id})` : sql``}
    order by k.created_at asc, k.id asc limit ${n}`;
  const items = rows.map((r) => ({
    id: r.id, body: r.body, createdAt: r.created_at,
    author: { id: r.author_id, handle: r.handle, kind: r.kind, displayName: r.display_name, avatarUrl: r.avatar_url },
  }));
  const next = items.length === n ? `${new Date(items[n - 1]!.createdAt).toISOString()}_${items[n - 1]!.id}` : null;
  return c.json({ items, next }, 200, publicCache(5));
});

social.post('/callouts/:id/comments', async (c) => {
  const me = requireMember(c, { scope: 'post' });
  await limit(c, 'write', [SOCIAL_LIMITS.comment]);
  const target = await calloutOr404(c.var.sql, c.req.param('id'));
  const text = body(c, 300);
  const id = `k_${randomId(14)}`;
  const [row] = await c.var.sql.begin(async (tx) => {
    const r = await tx<{ created_at: Date }[]>`insert into comments (id, callout_id, author_id, body) values (${id}, ${target.id}, ${me.id}, ${text}) returning created_at`;
    await tx`update callouts set comments = comments + 1 where id = ${target.id}`;
    return r;
  });
  return c.json({ comment: { id, body: text, createdAt: row!.created_at, author: { id: me.id, handle: me.handle, kind: me.kind, displayName: me.display_name, avatarUrl: me.avatar_url } } }, 201, PRIVATE);
});

/** The comment's author, or the callout's author (moderating their own thread), can delete it. */
social.delete('/comments/:id', async (c) => {
  const me = requireMember(c, { scope: 'post' });
  await limit(c, 'write');
  const rows = await c.var.sql.begin(async (tx) => {
    const r = await tx<{ callout_id: string }[]>`
      update comments k set deleted_at = now() from callouts c
      where k.id = ${c.req.param('id')} and k.deleted_at is null and c.id = k.callout_id and (k.author_id = ${me.id} or c.author_id = ${me.id})
      returning k.callout_id`;
    if (r.length) await tx`update callouts set comments = greatest(comments - 1, 0) where id = ${r[0]!.callout_id}`;
    return r;
  });
  if (!rows.length) throw fail(404, 'not_found', 'No such comment you can delete.');
  return c.json({ deleted: true }, 200, PRIVATE);
});

// ---- reports ----

/** `{ targetType: 'callout'|'comment'|'member', targetId, reason, note? }`. Three reports hide a post until reviewed. */
social.post('/reports', async (c) => {
  const me = requireMember(c, { scope: 'post' });
  await limit(c, 'write', [SOCIAL_LIMITS.report]);
  const b = (c.var.body ?? {}) as Record<string, unknown>;
  const type = b.targetType;
  if (type !== 'callout' && type !== 'comment' && type !== 'member') throw fail(422, 'invalid_field', 'targetType is callout, comment or member.', { field: 'targetType' });
  if (!REPORT_REASONS.includes(b.reason as never)) throw fail(422, 'invalid_field', `reason is one of ${REPORT_REASONS.join(', ')}.`, { field: 'reason' });
  const targetId = str(b.targetId, 64, 'targetId', { required: true })!;
  const note = str(b.note, 500, 'note');
  const sql = c.var.sql;
  const table = type === 'callout' ? 'callouts' : type === 'comment' ? 'comments' : 'members';
  const [exists] = await sql.unsafe(`select 1 from ${table} where id = $1`, [targetId]);
  if (!exists) throw fail(404, 'not_found', 'Nothing to report there.');
  if (type === 'member' && targetId === me.id) throw fail(422, 'invalid_field', "You can't report yourself.");
  await sql.begin(async (tx) => {
    const ins = await tx`insert into reports (reporter_id, target_type, target_id, reason, note) values (${me.id}, ${type}, ${targetId}, ${b.reason as string}, ${note})
      on conflict do nothing returning 1`;
    if (!ins.length || type === 'member') return;
    await tx.unsafe(
      `update ${table} set reports = reports + 1,
         hidden_at = case when hidden_at is null and reports + 1 >= $2 then now() else hidden_at end,
         hidden_reason = case when hidden_at is null and reports + 1 >= $2 then 'reports' else hidden_reason end
       where id = $1`,
      [targetId, AUTO_HIDE_REPORTS],
    );
  });
  return c.json({ reported: true }, 200, PRIVATE);
});

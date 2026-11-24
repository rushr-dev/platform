import type postgres from 'postgres';

/**
 * FOMO activity on Robinhood Chain, for markers on our token chart.
 *
 * Source: fomoapi.io, an independent API over FOMO's public app feed (not run by fomo.family). One feed,
 * GET /v2/alerts?chain=robinhood, carries both kinds we show:
 * - `thesis`: a FOMO trader's written reason for a trade ("X posted a thesis on $T: <text>").
 * - `buy` / `sell`: FOMO only publishes LARGE trades (roughly $1.4K+ positions), so these are the big moves.
 *
 * Polled from the cron with a cursor, so each poll returns only what is new. A poll that finds nothing
 * costs no credits; one that returns events costs 125. The key is FOMOAPI_KEY (a secret).
 */

const BASE = 'https://api.fomoapi.io';
const CURSOR_KEY = 'fomo:cursor';
/** Pages walked back per poll when more arrived than one page holds (each costs 125 credits). */
const MAX_PAGES = 5;
const PAGE = 100;

export type FomoKind = 'thesis' | 'buy' | 'sell';

export interface FomoAlert {
  id: string;
  type: string;
  trader: string | null;
  userId: string | null;
  tokenAddress: string | null;
  chainId: number | null;
  usdValue: number | null;
  positionValueUsd?: number | null;
  text: string | null;
  ts: number;
  avatar?: string | null;
}

interface AlertsPage {
  alerts: FomoAlert[];
  nextCursor: string | null;
  oldestCursor: string | null;
  hasMore: boolean;
}

export interface FomoRow {
  id: string;
  kind: FomoKind;
  token: string;
  handle: string;
  user_id: string | null;
  avatar_url: string | null;
  body: string | null;
  usd: number | null;
  ts: Date;
}

const ADDR = /^0x[0-9a-f]{40}$/;

/** "X posted a thesis on $T: text" → "text". Other alert texts stay as they are. */
export function thesisBody(text: string | null): string | null {
  if (!text) return null;
  const m = /^.*? posted a thesis on \$[^:]*:\s*([\s\S]*)$/.exec(text);
  const body = (m ? m[1]! : text).trim();
  return body || null;
}

/** One alert → one row, or null when it isn't a Robinhood thesis, buy or sell on a token address. */
export function toRow(a: FomoAlert): FomoRow | null {
  if (a.chainId !== 4663) return null;
  if (a.type !== 'thesis' && a.type !== 'buy' && a.type !== 'sell') return null;
  const token = a.tokenAddress?.toLowerCase() ?? '';
  if (!ADDR.test(token) || !a.trader || !Number.isFinite(a.ts)) return null;
  const usd = a.positionValueUsd ?? a.usdValue;
  return {
    id: a.id,
    kind: a.type,
    token,
    handle: a.trader,
    user_id: a.userId,
    avatar_url: a.avatar && /^https:\/\//.test(a.avatar) ? a.avatar : null,
    body: a.type === 'thesis' ? thesisBody(a.text) : a.text,
    usd: usd != null && Number.isFinite(usd) ? usd : null,
    ts: new Date(a.ts),
  };
}

async function page(key: string, params: Record<string, string>): Promise<AlertsPage> {
  const q = new URLSearchParams({ chain: 'robinhood', limit: String(PAGE), ...params });
  const r = await fetch(`${BASE}/v2/alerts?${q}`, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } });
  if (!r.ok) throw new Error(`fomoapi alerts ${r.status}`);
  const b = (await r.json()) as Partial<AlertsPage>;
  return { alerts: b.alerts ?? [], nextCursor: b.nextCursor ?? null, oldestCursor: b.oldestCursor ?? null, hasMore: !!b.hasMore };
}

/**
 * Fetch what is new since the stored cursor and save it. The first run takes the latest page only.
 * Returns how many rows were new.
 */
export async function pollFomo(sql: postgres.Sql, key: string): Promise<number> {
  const [state] = await sql<{ value: { cursor?: string } }[]>`select value from indexer_state where key = ${CURSOR_KEY}`;
  const cursor = state?.value.cursor;
  const first = await page(key, cursor ? { cursor } : {});
  const alerts = [...first.alerts];
  // More than a page arrived since last time: walk back (ts desc) until we reach the stored cursor.
  let more = cursor ? first.hasMore : false;
  let before = first.oldestCursor;
  for (let i = 1; more && before && i < MAX_PAGES; i++) {
    const p = await page(key, { cursor: cursor!, before });
    alerts.push(...p.alerts);
    more = p.hasMore;
    before = p.oldestCursor;
  }
  const rows = alerts.map(toRow).filter((r): r is FomoRow => r != null);
  let added = 0;
  if (rows.length) {
    const res = await sql`
      insert into fomo_events ${sql(rows, 'id', 'kind', 'token', 'handle', 'user_id', 'avatar_url', 'body', 'usd', 'ts')}
      on conflict (id) do nothing`;
    added = res.count;
  }
  const next = first.nextCursor ?? cursor;
  if (next && next !== cursor) {
    await sql`
      insert into indexer_state (key, value, updated_at) values (${CURSOR_KEY}, ${sql.json({ cursor: next })}, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  }
  return added;
}

export interface FomoMark {
  id: string;
  kind: FomoKind;
  handle: string;
  avatarUrl: string | null;
  body: string | null;
  usd: number | null;
  ts: string;
}

/** Latest FOMO theses and big trades on one token, newest first. */
export async function tokenFomo(sql: postgres.Sql, token: string, limit = 100): Promise<FomoMark[]> {
  const rows = await sql<{ id: string; kind: FomoKind; handle: string; avatar_url: string | null; body: string | null; usd: string | null; ts: Date }[]>`
    select id, kind, handle, avatar_url, body, usd, ts from fomo_events
    where token = ${token} order by ts desc limit ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    handle: r.handle,
    avatarUrl: r.avatar_url,
    body: r.body,
    usd: r.usd == null ? null : Number(r.usd),
    ts: r.ts.toISOString(),
  }));
}

/**
 * Theses posted without a new trade (attached to an older one) never reach the alerts feed above, so
 * for a few tokens we also read FOMO's per-token thesis list. It costs 1,250 credits a call, so each
 * token is refreshed at most once a day; THESIS_TOKENS is the whole list (only $RUSHR for now).
 */
export const THESIS_TOKENS = ['0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed'];
const THESIS_EVERY_MS = 24 * 3_600_000;

export interface TokenThesis {
  id: string;
  handle: string | null;
  userId?: string | null;
  avatar?: string | null;
  text: string | null;
  ts: string;
  networkId?: number | null;
  token?: { address?: string | null } | null;
}

/** One thesis from /v2/thesis/token → a fomo_events row, or null when it is unusable. */
export function thesisRow(t: TokenThesis, token: string): FomoRow | null {
  const ts = Date.parse(t.ts);
  const addr = (t.token?.address ?? token).toLowerCase();
  if (!t.id || !t.handle || !Number.isFinite(ts) || addr !== token || (t.networkId != null && t.networkId !== 4663)) return null;
  const body = t.text?.trim() || null;
  if (!body) return null;
  return {
    id: t.id,
    kind: 'thesis',
    token,
    handle: t.handle,
    user_id: t.userId ?? null,
    avatar_url: t.avatar && /^https:\/\//.test(t.avatar) ? t.avatar : null,
    body,
    usd: null,
    ts: new Date(ts),
  };
}

/**
 * Refresh THESIS_TOKENS whose last refresh is over a day old. The same thesis can also arrive through
 * the alerts feed under another id, so a row is skipped when that trader already has that text there.
 * Returns how many rows were new.
 */
export async function refreshTokenTheses(sql: postgres.Sql, key: string, now = Date.now()): Promise<number> {
  let added = 0;
  for (const token of THESIS_TOKENS) {
    const stateKey = `fomo:theses:${token}`;
    const [state] = await sql<{ updated_at: Date }[]>`select updated_at from indexer_state where key = ${stateKey}`;
    if (state && now - state.updated_at.getTime() < THESIS_EVERY_MS) continue;
    // Mark first, so a failing call is not retried (and charged) every cron tick.
    await sql`
      insert into indexer_state (key, value, updated_at) values (${stateKey}, ${sql.json({})}, now())
      on conflict (key) do update set updated_at = now()`;
    const r = await fetch(`${BASE}/v2/thesis/token/${token}?chain=robinhood`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    });
    if (!r.ok) throw new Error(`fomoapi theses ${r.status}`);
    const b = (await r.json()) as { theses?: TokenThesis[] };
    for (const row of (b.theses ?? []).map((t) => thesisRow(t, token)).filter((x): x is FomoRow => x != null)) {
      const res = await sql`
        insert into fomo_events (id, kind, token, handle, user_id, avatar_url, body, usd, ts)
        select ${row.id}, 'thesis', ${row.token}, ${row.handle}, ${row.user_id}, ${row.avatar_url}, ${row.body}, null, ${row.ts}
        where not exists (
          select 1 from fomo_events where token = ${row.token} and kind = 'thesis' and handle = ${row.handle} and body = ${row.body})
        on conflict (id) do nothing`;
      added += res.count;
    }
  }
  return added;
}

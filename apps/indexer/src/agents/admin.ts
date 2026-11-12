// Moderation and beta admin. Mounted by index.ts under /admin/agents, behind the existing ADMIN_TOKEN check.
import { Hono } from 'hono';
import { randomBytes } from '@rushr/agents/crypto';
import { body, db, errorResponse, fail, str, type Ctx } from './http';
import { normalizeInvite } from './members';
import { freezeSeason } from './board';

export const adminV1 = new Hono<Ctx>();
adminV1.onError((e, c) => errorResponse(c, e));
adminV1.use('*', db, body, async (c, next) => {
  c.set('viewer', {});
  await next();
});

const NO_STORE = { 'cache-control': 'no-store' };

adminV1.get('/reports', async (c) => {
  const open = c.req.query('all') !== '1';
  const rows = await c.var.sql`
    select r.id, r.target_type, r.target_id, r.reason, r.note, r.created_at, r.resolved_at, r.resolution, m.handle as reporter
    from reports r join members m on m.id = r.reporter_id
    ${open ? c.var.sql`where r.resolved_at is null` : c.var.sql``}
    order by r.created_at desc limit 200`;
  return c.json({ reports: rows }, 200, NO_STORE);
});

adminV1.post('/reports/:id/resolve', async (c) => {
  const b = (c.var.body ?? {}) as Record<string, unknown>;
  const resolution = str(b.resolution, 200, 'resolution') ?? 'reviewed';
  const rows = await c.var.sql`update reports set resolved_at = now(), resolution = ${resolution} where id = ${Number(c.req.param('id'))} returning id`;
  if (!rows.length) throw fail(404, 'not_found', 'No such report.');
  return c.json({ resolved: true }, 200, NO_STORE);
});

for (const [path, table] of [['callouts', 'callouts'], ['comments', 'comments']] as const) {
  adminV1.post(`/${path}/:id/hide`, async (c) => {
    const reason = str(((c.var.body ?? {}) as Record<string, unknown>).reason, 200, 'reason') ?? 'moderator';
    const rows = await c.var.sql.unsafe(`update ${table} set hidden_at = now(), hidden_reason = $2 where id = $1 returning id`, [c.req.param('id'), reason]);
    if (!rows.length) throw fail(404, 'not_found', 'Not found.');
    return c.json({ hidden: true }, 200, NO_STORE);
  });
  adminV1.post(`/${path}/:id/unhide`, async (c) => {
    const rows = await c.var.sql.unsafe(`update ${table} set hidden_at = null, hidden_reason = null where id = $1 returning id`, [c.req.param('id')]);
    if (!rows.length) throw fail(404, 'not_found', 'Not found.');
    return c.json({ hidden: false }, 200, NO_STORE);
  });
}

adminV1.post('/members/:id/:action{suspend|unsuspend}', async (c) => {
  const status = c.req.param('action') === 'suspend' ? 'suspended' : 'active';
  const sql = c.var.sql;
  const rows = await sql.begin(async (tx) => {
    const r = await tx`update members set status = ${status}, updated_at = now() where id = ${c.req.param('id')} returning id`;
    if (r.length) {
      await tx`insert into member_events (member_id, type) values (${c.req.param('id')}, ${status === 'suspended' ? 'suspend' : 'unsuspend'})`;
      if (status === 'suspended') await tx`update api_keys set revoked_at = now() where member_id = ${c.req.param('id')} and revoked_at is null`;
    }
    return r;
  });
  if (!rows.length) throw fail(404, 'not_found', 'No such member.');
  return c.json({ status }, 200, NO_STORE);
});

// ---- invite codes (beta) ----

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
function inviteCode(prefix: string): string {
  let out = '';
  for (const b of randomBytes(8)) out += CODE_ALPHABET[b % 32];
  return `${prefix}-${out}`;
}

/** Create a batch: `{ batch, count (1-1000), prefix? (default RUSHR), expiresAt?, note? }` → the codes. */
adminV1.post('/invites', async (c) => {
  const b = (c.var.body ?? {}) as Record<string, unknown>;
  const batch = str(b.batch, 40, 'batch', { required: true })!;
  const count = Number(b.count ?? 1);
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw fail(422, 'invalid_field', 'count is 1-1000.', { field: 'count' });
  const prefix = (typeof b.prefix === 'string' ? b.prefix : 'RUSHR').toUpperCase();
  if (!/^[A-Z0-9]{2,12}$/.test(prefix)) throw fail(422, 'invalid_field', 'prefix is 2-12 chars A-Z 0-9.', { field: 'prefix' });
  const expiresAt = b.expiresAt ? new Date(String(b.expiresAt)) : null;
  if (expiresAt && Number.isNaN(expiresAt.getTime())) throw fail(422, 'invalid_field', 'expiresAt must be an ISO date.', { field: 'expiresAt' });
  const note = str(b.note, 200, 'note');
  const codes = new Set<string>();
  while (codes.size < count) codes.add(inviteCode(prefix));
  const rows = [...codes].map((code) => ({ code, batch, note, expires_at: expiresAt }));
  await c.var.sql`insert into invite_codes ${c.var.sql(rows, 'code', 'batch', 'note', 'expires_at')} on conflict do nothing`;
  return c.json({ batch, codes: [...codes] }, 201, NO_STORE);
});

/** `?batch=` to filter. Shows who used each code. */
adminV1.get('/invites', async (c) => {
  const sql = c.var.sql;
  const batch = c.req.query('batch');
  const rows = await sql`
    select i.code, i.batch, i.note, i.created_at, i.expires_at, i.used_at, i.revoked_at, m.handle as used_by
    from invite_codes i left join members m on m.id = i.used_by
    ${batch ? sql`where i.batch = ${batch}` : sql``}
    order by i.created_at desc, i.code limit 5000`;
  const used = rows.filter((r) => r.used_at).length;
  return c.json({ total: rows.length, used, invites: rows }, 200, NO_STORE);
});

adminV1.post('/invites/:code/revoke', async (c) => {
  const code = normalizeInvite(c.req.param('code'));
  const rows = code ? await c.var.sql`update invite_codes set revoked_at = now() where code = ${code} and used_at is null and revoked_at is null returning code` : [];
  if (!rows.length) throw fail(404, 'not_found', 'No unused code like that.');
  return c.json({ revoked: true }, 200, NO_STORE);
});

adminV1.get('/feedback', async (c) => {
  const rows = await c.var.sql`
    select f.id::text, f.page, f.message, f.user_agent, f.created_at, m.handle
    from feedback f left join members m on m.id = f.member_id
    order by f.created_at desc limit ${Math.min(Number(c.req.query('limit') ?? 200) || 200, 1000)}`;
  return c.json({ feedback: rows }, 200, NO_STORE);
});

// ---- seasons ----

/** `{ id: 's0', name: 'Season 0', startsAt, endsAt }` (upsert). */
adminV1.post('/seasons', async (c) => {
  const b = (c.var.body ?? {}) as Record<string, unknown>;
  const id = str(b.id, 20, 'id', { required: true })!;
  if (!/^[a-z0-9_-]+$/.test(id)) throw fail(422, 'invalid_field', 'id is a-z 0-9 _ -.', { field: 'id' });
  const name = str(b.name, 60, 'name', { required: true })!;
  const startsAt = new Date(String(b.startsAt));
  const endsAt = new Date(String(b.endsAt));
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) throw fail(422, 'invalid_field', 'startsAt and endsAt must be ISO dates, end after start.');
  await c.var.sql`insert into seasons (id, name, starts_at, ends_at) values (${id}, ${name}, ${startsAt}, ${endsAt})
    on conflict (id) do update set name = excluded.name, starts_at = excluded.starts_at, ends_at = excluded.ends_at`;
  return c.json({ season: { id, name, startsAt, endsAt } }, 200, NO_STORE);
});

adminV1.post('/seasons/:id/freeze', async (c) => c.json(await freezeSeason(c.var.sql, c.req.param('id')), 200, NO_STORE));

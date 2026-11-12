// Moderation and beta admin. Mounted by index.ts under /admin/agents, behind the existing ADMIN_TOKEN check.
import { Hono } from 'hono';
import { body, db, errorResponse, fail, str, type Ctx } from './http';

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

// Beta wrapper: feedback from anyone (signed in or not).
import { Hono } from 'hono';
import { SOCIAL_LIMITS } from '@rushr/agents/limits';
import { on } from './env';
import { limit, PRIVATE, publicCache, str, type Ctx } from './http';

export const beta = new Hono<Ctx>();

/** `{ message (1-2000), page? }`. Stores the member when signed in. */
beta.post('/feedback', async (c) => {
  await limit(c, 'write', [SOCIAL_LIMITS.feedback]);
  const b = (c.var.body ?? {}) as Record<string, unknown>;
  const message = str(b.message, 2000, 'message', { required: true })!;
  const page = str(b.page, 300, 'page');
  const ua = (c.req.header('user-agent') ?? '').slice(0, 300) || null;
  const [row] = await c.var.sql<{ id: string }[]>`
    insert into feedback (member_id, page, message, user_agent) values (${c.var.viewer.member?.id ?? null}, ${page}, ${message}, ${ua}) returning id::text`;
  return c.json({ received: true, id: row!.id }, 201, PRIVATE);
});

/**
 * Public seat counter for the beta drop, from the code marked `public` (never the code itself).
 * `open` = sign-up through that code works right now.
 */
beta.get('/beta', async (c) => {
  const [row] = await c.var.sql<{ max_uses: number; uses: number; revoked_at: Date | null; expires_at: Date | null }[]>`
    select max_uses, uses, revoked_at, expires_at from invite_codes where public limit 1`;
  const invitesRequired = on(c.env.INVITES_REQUIRED);
  if (!row) return c.json({ open: false, seats: 0, taken: 0, left: 0, invitesRequired }, 200, publicCache(10));
  const live = !row.revoked_at && (!row.expires_at || row.expires_at.getTime() > Date.now());
  const left = live ? Math.max(row.max_uses - row.uses, 0) : 0;
  return c.json({ open: left > 0, seats: row.max_uses, taken: row.uses, left, invitesRequired }, 200, publicCache(10));
});

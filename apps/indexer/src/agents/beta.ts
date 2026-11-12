// Beta wrapper: feedback from anyone (signed in or not).
import { Hono } from 'hono';
import { SOCIAL_LIMITS } from '@rushr/agents/limits';
import { limit, PRIVATE, str, type Ctx } from './http';

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

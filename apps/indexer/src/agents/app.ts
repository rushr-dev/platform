// /v1: members, social, leaderboard and agents. Mounted by index.ts as `app.route('/v1', v1)`.
// Everything is off unless AGENTS_ENABLED=1. Rushr never holds keys, never signs, never trades for anyone.
import { Hono } from 'hono';
import { auth, body, db, errorResponse, flag, ip, limit, type Ctx } from './http';
import { members } from './members';
import { social } from './social';
import { beta } from './beta';
import { leaderboard } from './board';
import { agents } from './agents';
import { media } from './media';
import { LLMS_TXT } from '@rushr/agents/llms-txt';
export { adminV1 } from './admin';

export const v1 = new Hono<Ctx>();

v1.onError((e, c) => errorResponse(c, e));
v1.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint.', docs: 'https://rushr.trade/llms.txt' } }, 404));
v1.use('*', flag('AGENTS_ENABLED', 'The members API'), db, ip, body, auth);
// The documented read limit for agents: every GET with an API key counts (60/min per key). Expensive
// public reads are limited for everyone in their handlers (expensiveRead).
v1.use('*', async (c, next) => {
  if (c.req.method === 'GET' && c.var.viewer.keyId) await limit(c, 'read');
  await next();
});

v1.route('/', members);
v1.route('/', social);
v1.route('/', beta);
v1.route('/', leaderboard);
v1.route('/', agents);
v1.route('/', media);

/** The agent instructions, also at /llms.txt on the API and the website. */
v1.get('/llms.txt', (c) => c.body(LLMS_TXT, 200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300, s-maxage=300' }));

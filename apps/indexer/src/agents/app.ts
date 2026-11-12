// /v1: members, social, leaderboard and agents. Mounted by index.ts as `app.route('/v1', v1)`.
// Everything is off unless AGENTS_ENABLED=1. Rushr never holds keys, never signs, never trades for anyone.
import { Hono } from 'hono';
import { auth, body, db, errorResponse, flag, ip, type Ctx } from './http';
import { members } from './members';
import { social } from './social';
import { beta } from './beta';
import { leaderboard } from './board';
import { agents } from './agents';
import { media } from './media';
export { adminV1 } from './admin';

export const v1 = new Hono<Ctx>();

v1.onError((e, c) => errorResponse(c, e));
v1.notFound((c) => c.json({ error: { code: 'not_found', message: 'No such endpoint.', docs: 'https://rushr.trade/llms.txt' } }, 404));
v1.use('*', flag('AGENTS_ENABLED', 'The members API'), db, ip, body, auth);

v1.route('/', members);
v1.route('/', social);
v1.route('/', beta);
v1.route('/', leaderboard);
v1.route('/', agents);
v1.route('/', media);

// Shared plumbing for /v1: database per request, errors, body parsing, auth and rate limits.
import type { Context, MiddlewareHandler } from 'hono';
import postgres, { type Sql } from 'postgres';
import { findKeyMaterial } from '@rushr/agents/guard';
import { parseApiKey, sha256Hex, safeEqual } from '@rushr/agents/crypto';
import { IP_LIMITS, KEY_LIMITS, OWNER_LIMITS, retryAfter, windowStart, type Bucket, type Limit } from '@rushr/agents/limits';
import { dbUrl } from '../env';
import { on, type AgentsEnv } from './env';
import { fetchPrivyProfile, verifyPrivyToken, type PrivyProfile } from './privy';

export interface MemberRow {
  id: string;
  kind: 'human' | 'agent';
  origin: 'self' | 'external' | 'in_app' | null;
  handle: string;
  wallet: string;
  privy_did: string | null;
  owner_id: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  x_username: string | null;
  x_verified: boolean;
  followers: number;
  following: number;
  status: 'active' | 'suspended';
  created_at: Date;
}

export interface Viewer {
  /** Set when a Privy token was verified, even before the human has a member row. */
  privyDid?: string;
  member?: MemberRow;
  keyId?: string;
  scopes?: string[];
}

export type Ctx = { Bindings: AgentsEnv; Variables: { sql: Sql; viewer: Viewer; body: unknown; ipHash: string } };
export type C = Context<Ctx>;

export class ApiError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 422 | 429 | 503, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export const fail = (status: ApiError['status'], code: string, message: string, extra: Record<string, unknown> = {}) => new ApiError(status, code, message, extra);

export function errorResponse(c: C, e: unknown) {
  if (e instanceof ApiError) {
    const headers: Record<string, string> = { 'cache-control': 'no-store' };
    if (typeof e.extra.retryAfter === 'number') headers['retry-after'] = String(e.extra.retryAfter);
    return c.json({ error: { code: e.code, message: e.message, docs: 'https://rushr.trade/llms.txt', ...e.extra } }, e.status, headers);
  }
  // Unique violations surface as 409s with a generic code; everything else is a 500 without details.
  if (e && typeof e === 'object' && (e as { code?: string }).code === '23505') {
    return c.json({ error: { code: 'conflict', message: 'Already exists.' } }, 409, { 'cache-control': 'no-store' });
  }
  console.error('v1 error', e instanceof Error ? e.message : e);
  return c.json({ error: { code: 'internal', message: 'Something went wrong.' } }, 500, { 'cache-control': 'no-store' });
}

/** Public, edge-cacheable responses. Never put viewer-specific fields in one. */
export const publicCache = (seconds: number) => ({ 'cache-control': `public, max-age=${seconds}, s-maxage=${seconds}` });
export const PRIVATE = { 'cache-control': 'private, no-store' };

export const db: MiddlewareHandler<Ctx> = async (c, next) => {
  const sql = postgres(dbUrl(c.env), { max: 2, fetch_types: false, prepare: false, onnotice: () => {} });
  c.set('sql', sql);
  try {
    await next();
  } finally {
    const end = sql.end({ timeout: 5 });
    try {
      c.executionCtx.waitUntil(end);
    } catch {
      await end; // no execution context (tests)
    }
  }
};

/**
 * Top-level fields that may look like a key on specific routes, because the handler verifies them
 * against the chain before storing anything. POST /v1/trades: `txHash` must be a real tx sent from the
 * member's wallet (Data's trade ledger).
 */
const KEY_SHAPED_ALLOWED: { method: string; path: RegExp; fields: readonly string[] }[] = [
  { method: 'POST', path: /^(\/v1)?\/trades\/?$/, fields: ['txHash'] },
];

/** JSON bodies only, at most 16KB, and never anything that looks like a private key or seed phrase. */
export const body: MiddlewareHandler<Ctx> = async (c, next) => {
  if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') return next();
  const text = await c.req.text();
  if (text.length > 16_384) throw fail(413, 'too_large', 'Request body is over 16KB.');
  let parsed: unknown = {};
  if (text.trim()) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw fail(400, 'invalid_json', 'Body must be JSON.');
    }
  }
  const allow = KEY_SHAPED_ALLOWED.find((a) => a.method === c.req.method && a.path.test(c.req.path))?.fields;
  const hit = findKeyMaterial(parsed, { allow });
  if (hit) {
    throw fail(400, 'never_send_keys', `Field "${hit}" looks like a private key or seed phrase. Rushr never accepts keys: you sign locally and send only signatures.`);
  }
  c.set('body', parsed);
  await next();
};

export const ip: MiddlewareHandler<Ctx> = async (c, next) => {
  const raw = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  c.set('ipHash', (await sha256Hex(`${c.env.IP_SALT ?? 'dev-salt'}|${raw}`)).slice(0, 32));
  await next();
};

/** Production web origins. `WEB_ORIGINS` (comma separated) replaces this list when set. */
export const DEFAULT_WEB_ORIGINS = ['https://rushr.trade', 'https://www.rushr.trade'];

/**
 * Browser calls with a Privy token must come from the web app (CSRF and token-theft hygiene).
 * Local web dev servers (http://localhost:*) are allowed only when the API itself runs on localhost
 * (wrangler dev), never in production.
 */
export function allowedOrigin(origin: string | undefined, requestUrl: string, configured?: string): boolean {
  if (!origin) return true; // server-to-server or curl: the bearer token is the proof
  const allowed = configured ? configured.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_WEB_ORIGINS;
  if (allowed.includes(origin)) return true;
  const apiHost = new URL(requestUrl).hostname;
  const local = apiHost === 'localhost' || apiHost === '127.0.0.1';
  return local && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

const MEMBER_COLUMNS = 'id, kind, origin, handle, wallet, privy_did, owner_id, display_name, bio, avatar_url, x_username, x_verified, followers, following, status, created_at';
export const memberColumns = MEMBER_COLUMNS;

/** Resolve the caller: `Authorization: Bearer <privy access token>` (humans) or `Bearer rk_…` (agents). */
export const auth: MiddlewareHandler<Ctx> = async (c, next) => {
  const viewer: Viewer = {};
  c.set('viewer', viewer);
  const header = c.req.header('authorization');
  if (!header) return next();
  const token = header.replace(/^Bearer\s+/i, '').trim();
  const sql = c.var.sql;
  if (token.startsWith('rk_')) {
    const parsed = parseApiKey(token);
    if (!parsed) throw fail(401, 'invalid_key', 'Malformed API key.');
    const [row] = await sql<{ id: string; member_id: string; secret_hash: string; scopes: string[]; last_used_at: Date | null }[]>`
      select id, member_id, secret_hash, scopes, last_used_at from api_keys where id = ${parsed.id} and revoked_at is null`;
    if (!row || !safeEqual(await sha256Hex(parsed.secret), row.secret_hash)) throw fail(401, 'invalid_key', 'Unknown or revoked API key.');
    const [member] = await sql.unsafe<MemberRow[]>(`select ${MEMBER_COLUMNS} from members where id = $1`, [row.member_id]);
    if (!member || member.status !== 'active') throw fail(403, 'suspended', 'This account is suspended.');
    Object.assign(viewer, { member, keyId: row.id, scopes: row.scopes });
    if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 60_000) {
      await sql`update api_keys set last_used_at = now() where id = ${row.id}`;
    }
    return next();
  }
  const appId = c.env.PRIVY_APP_ID;
  if (!appId) throw fail(503, 'auth_unavailable', 'Sign-in is not configured.');
  if (!allowedOrigin(c.req.header('origin'), c.req.url, c.env.WEB_ORIGINS)) throw fail(403, 'bad_origin', 'Requests with a session must come from the Rushr web app.');
  const r = await verifyPrivyToken(token, appId);
  if (!r.ok) throw fail(401, r.error, 'Invalid or expired session. Sign in again.');
  viewer.privyDid = r.claims.did;
  const [member] = await sql.unsafe<MemberRow[]>(`select ${MEMBER_COLUMNS} from members where privy_did = $1`, [r.claims.did]);
  if (member) {
    if (member.status !== 'active') throw fail(403, 'suspended', 'This account is suspended.');
    viewer.member = member;
  }
  return next();
};

export function requireMember(c: C, opts: { kind?: 'human' | 'agent'; scope?: string } = {}): MemberRow {
  const v = c.var.viewer;
  if (!v.member) {
    if (v.privyDid) throw fail(403, 'not_registered', 'Finish sign-up first (POST /v1/me).');
    throw fail(401, 'unauthorized', 'Sign in (Privy) or send an agent API key.');
  }
  if (opts.kind && v.member.kind !== opts.kind) throw fail(403, 'wrong_kind', `Only ${opts.kind}s can do this.`);
  if (opts.scope && v.keyId && !v.scopes?.includes(opts.scope)) throw fail(403, 'missing_scope', `This key lacks the "${opts.scope}" scope.`);
  return v.member;
}

async function bump(sql: Sql, subject: string, limit: Limit, now: Date): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    insert into api_usage (subject, bucket, window_start, count) values (${subject}, ${limit.bucket}, ${windowStart(now, limit.windowSec)}, 1)
    on conflict (subject, bucket, window_start) do update set count = api_usage.count + 1
    returning count`;
  return row!.count;
}

/**
 * Count one request against every subject it belongs to: the agent key, the owner's pool (owned
 * agents and the human), and the IP when there's no member. Throws rate_limited when any is over.
 */
export async function limit(c: C, bucket: Bucket, extra: Limit[] = []) {
  const now = new Date();
  const v = c.var.viewer;
  const checks: [string, Limit][] = [];
  if (v.keyId && KEY_LIMITS[bucket]) checks.push([`key:${v.keyId}`, KEY_LIMITS[bucket]!]);
  const pool = v.member ? (v.member.owner_id ?? (v.member.kind === 'human' ? v.member.id : null)) : null;
  if (pool && OWNER_LIMITS[bucket]) checks.push([`owner:${pool}`, OWNER_LIMITS[bucket]!]);
  if (v.member && !v.keyId && !pool && KEY_LIMITS[bucket]) checks.push([`member:${v.member.id}`, KEY_LIMITS[bucket]!]);
  if (!v.member && IP_LIMITS[bucket]) checks.push([`ip:${c.var.ipHash}`, IP_LIMITS[bucket]!]);
  const subject = v.member ? `member:${v.member.id}` : `ip:${c.var.ipHash}`;
  for (const l of extra) checks.push([subject, l]);
  for (const [s, l] of checks) {
    const count = await bump(c.var.sql, s, l, now);
    if (count > l.max) {
      throw fail(429, 'rate_limited', `Too many requests (${l.bucket}: ${l.max} per ${l.windowSec}s).`, { retryAfter: retryAfter(now, l.windowSec) });
    }
  }
}

export const flag = (name: keyof AgentsEnv, what: string): MiddlewareHandler<Ctx> => async (c, next) => {
  if (!on(c.env[name] as string | undefined)) throw fail(404, 'feature_disabled', `${what} is not enabled yet.`);
  await next();
};

/** Privy profile for the signed-in human (embedded wallet, X). Needs the app secret. */
export async function privyProfile(c: C, did: string): Promise<PrivyProfile> {
  const { PRIVY_APP_ID: appId, PRIVY_APP_SECRET: secret } = c.env;
  if (!appId || !secret) throw fail(503, 'auth_unavailable', 'Sign-up is not configured.');
  const p = await fetchPrivyProfile(did, appId, secret);
  if (!p) throw fail(503, 'privy_unavailable', 'Could not reach Privy. Try again.');
  return p;
}

export const str = (v: unknown, max: number, field: string, opts: { required?: boolean; min?: number } = {}): string | null => {
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw fail(422, 'invalid_field', `${field} is required.`, { field });
    return null;
  }
  if (typeof v !== 'string') throw fail(422, 'invalid_field', `${field} must be a string.`, { field });
  const s = v.trim().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '');
  if (s.length > max || s.length < (opts.min ?? 0)) throw fail(422, 'invalid_field', `${field} must be ${opts.min ?? 0}-${max} characters.`, { field });
  if (opts.required && !s) throw fail(422, 'invalid_field', `${field} is required.`, { field });
  return s || null;
};

export const httpsUrl = (v: unknown, field: string): string | null => {
  const s = str(v, 400, field);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:') throw new Error();
    return u.toString();
  } catch {
    throw fail(422, 'invalid_field', `${field} must be an https URL.`, { field });
  }
};

export const isAddr = (s: string) => /^0x[0-9a-f]{40}$/.test(s);

/** Ask the indexer to resolve a new member wallet's first funder and contract status (for cluster rules). */
export async function enqueueWalletFunding(c: C, wallet: string) {
  try {
    await c.env.ENRICH_QUEUE?.send({ kind: 'wallet-funding', wallet });
  } catch (e) {
    console.error('wallet-funding enqueue failed', e instanceof Error ? e.message : e);
  }
}

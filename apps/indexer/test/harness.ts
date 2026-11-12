// Test harness for /v1: a throwaway local Postgres, a fake Privy (our own ES256 key + stubbed REST),
// and a request helper. No network, no production data.
import { vi } from 'vitest';
import { freshDb, pgAvailable } from '../../../packages/agents/test/pg';
import { setPrivyKeys } from '../src/agents/privy';
import { v1, adminV1 } from '../src/agents/app';
import type { ApiJson } from './api';

export { pgAvailable };
export const APP_ID = 'test-app';

const b64url = (b: Uint8Array | string) =>
  Buffer.from(typeof b === 'string' ? new TextEncoder().encode(b) : b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** In-memory stand-in for the R2 bucket binding (put, get, delete). */
export function memoryR2() {
  const objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  return {
    objects,
    async put(key: string, value: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes: value, contentType: opts?.httpMetadata?.contentType });
    },
    async get(key: string) {
      const o = objects.get(key);
      return o ? { body: o.bytes, httpMetadata: { contentType: o.contentType } } : null;
    },
    async delete(keys: string | string[]) {
      for (const k of Array.isArray(keys) ? keys : [keys]) objects.delete(k);
    },
  };
}

export async function setup(name: string, envOverrides: Record<string, unknown> = {}) {
  const { url, sql, drop } = await freshDb(name);
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  await setPrivyKeys(APP_ID, [{ ...jwk, kid: 'test-kid' }]);

  /** did → linked accounts the fake Privy API returns. */
  const privyUsers = new Map<string, unknown[]>();
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    const m = /^https:\/\/api\.privy\.io\/v1\/users\/(.+)$/.exec(u);
    if (m) {
      const did = decodeURIComponent(m[1]!);
      const auth = new Headers(init?.headers).get('authorization');
      if (auth !== `Basic ${btoa(`${APP_ID}:test-secret`)}`) return new Response('{}', { status: 401 });
      const accounts = privyUsers.get(did);
      return accounts ? Response.json({ id: did, linked_accounts: accounts }) : new Response('{}', { status: 404 });
    }
    if (u.startsWith('https://')) throw new Error(`unexpected network call in test: ${u}`);
    return realFetch(input, init);
  });

  const env = {
    AGENTS_ENABLED: '1',
    LEADERBOARD_ENABLED: '1',
    AGENT_SIGNUP_ENABLED: '1',
    DATABASE_URL: url,
    PRIVY_APP_ID: APP_ID,
    PRIVY_APP_SECRET: 'test-secret',
    ...envOverrides,
  };

  async function token(did: string, opts: { expIn?: number; aud?: string } = {}) {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'test-kid' }));
    const payload = b64url(JSON.stringify({ iss: 'privy.io', aud: opts.aud ?? APP_ID, sub: did, sid: 'sess', iat: now, exp: now + (opts.expIn ?? 3600) }));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(`${header}.${payload}`)));
    return `${header}.${payload}.${b64url(sig)}`;
  }

  /** A Privy user with an embedded wallet (and optionally X). Returns their bearer token. */
  async function human(did: string, wallet: string, x?: string) {
    const accounts: unknown[] = [{ type: 'wallet', address: wallet, chain_type: 'ethereum', connector_type: 'embedded', wallet_client_type: 'privy', wallet_index: 0 }];
    if (x) accounts.push({ type: 'twitter_oauth', username: x, profile_picture_url: `https://pbs.example/${x}.jpg` });
    privyUsers.set(did, accounts);
    return token(did);
  }

  async function call(method: string, path: string, opts: { auth?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    // Raw bytes (uploads) go as-is; everything else as JSON.
    // A fresh client IP per call unless the test pins one, so per-IP limits only bite where tested.
    const headers: Record<string, string> = { 'content-type': 'application/json', 'cf-connecting-ip': `10.0.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`, ...opts.headers };
    if (opts.auth) headers.authorization = `Bearer ${opts.auth}`;
    const raw = opts.body instanceof Uint8Array ? opts.body : opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const res = await v1.request(path, { method, headers, body: raw }, env);
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : null) as ApiJson };
  }

  /** Sign a human up (no invite needed unless the env requires it). Returns { token, member }. */
  async function signup(handle: string, wallet: string) {
    const tok = await human(`did:privy:${handle}`, wallet);
    const r = await call('POST', '/me', { auth: tok, body: { handle } });
    if (r.status !== 201) throw new Error(`signup ${handle}: ${JSON.stringify(r.json)}`);
    return { token: tok, member: r.json.member };
  }

  async function admin(method: string, path: string, body?: unknown) {
    const res = await adminV1.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : null) as ApiJson };
  }

  return {
    sql, env, token, human, call, signup, admin, privyUsers,
    teardown: async () => {
      vi.unstubAllGlobals();
      await setPrivyKeys(APP_ID, null);
      await drop();
    },
  };
}

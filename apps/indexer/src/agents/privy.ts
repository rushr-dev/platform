// Privy access tokens (ES256 JWTs) verified locally against Privy's JWKS, plus a lookup of the
// user's embedded wallet and X account through Privy's REST API (app secret, server side only).

export const PRIVY_ISSUER = 'privy.io';
const JWKS_TTL_MS = 60 * 60_000;

export interface PrivyClaims {
  did: string;
  sessionId: string | null;
  expiresAt: Date;
}

type Jwk = JsonWebKey & { kid?: string };
let jwksCache: { appId: string; at: number; keys: Map<string, CryptoKey> } | null = null;

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const json = (s: string) => JSON.parse(new TextDecoder().decode(b64url(s))) as Record<string, unknown>;

/** Test hook: install keys directly instead of fetching the JWKS. */
export async function setPrivyKeys(appId: string, jwks: Jwk[] | null) {
  if (!jwks) {
    jwksCache = null;
    return;
  }
  jwksCache = { appId, at: Date.now() + 365 * 86_400_000, keys: await importKeys(jwks) };
}

async function importKeys(keys: Jwk[]): Promise<Map<string, CryptoKey>> {
  const out = new Map<string, CryptoKey>();
  for (const k of keys) {
    if (k.kty !== 'EC' || k.crv !== 'P-256' || !k.kid) continue;
    const { kid, ...jwk } = k;
    out.set(kid, await crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']));
  }
  return out;
}

async function keysFor(appId: string, kid: string, fetcher: typeof fetch): Promise<CryptoKey | null> {
  const fresh = jwksCache && jwksCache.appId === appId && Date.now() - jwksCache.at < JWKS_TTL_MS;
  if (fresh && jwksCache!.keys.has(kid)) return jwksCache!.keys.get(kid)!;
  // Unknown kid or stale cache: refetch once (key rotation).
  const res = await fetcher(`https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}/jwks.json`);
  const body = (await res.json().catch(() => null)) as { keys?: Jwk[] } | null;
  if (!res.ok || !body?.keys) return jwksCache?.keys.get(kid) ?? null;
  jwksCache = { appId, at: Date.now(), keys: await importKeys(body.keys) };
  return jwksCache.keys.get(kid) ?? null;
}

export type PrivyTokenError = 'token_malformed' | 'token_signature' | 'token_expired' | 'token_claims';

export async function verifyPrivyToken(token: string, appId: string, opts: { now?: Date; fetcher?: typeof fetch } = {}): Promise<{ ok: true; claims: PrivyClaims } | { ok: false; error: PrivyTokenError }> {
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 4096) return { ok: false, error: 'token_malformed' };
  let header: Record<string, unknown>, payload: Record<string, unknown>;
  try {
    header = json(parts[0]!);
    payload = json(parts[1]!);
  } catch {
    return { ok: false, error: 'token_malformed' };
  }
  if (header.alg !== 'ES256' || typeof header.kid !== 'string') return { ok: false, error: 'token_malformed' };
  const key = await keysFor(appId, header.kid, opts.fetcher ?? fetch);
  if (!key) return { ok: false, error: 'token_signature' };
  const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) return { ok: false, error: 'token_signature' };
  const now = (opts.now ?? new Date()).getTime() / 1000;
  const aud = payload.aud;
  if (payload.iss !== PRIVY_ISSUER || !(aud === appId || (Array.isArray(aud) && aud.includes(appId)))) return { ok: false, error: 'token_claims' };
  if (typeof payload.sub !== 'string' || !payload.sub.startsWith('did:privy:')) return { ok: false, error: 'token_claims' };
  if (typeof payload.exp !== 'number' || payload.exp < now) return { ok: false, error: 'token_expired' };
  if (typeof payload.iat === 'number' && payload.iat > now + 60) return { ok: false, error: 'token_claims' };
  return { ok: true, claims: { did: payload.sub, sessionId: typeof payload.sid === 'string' ? payload.sid : null, expiresAt: new Date(payload.exp * 1000) } };
}

export interface PrivyProfile {
  /** The Privy embedded Ethereum wallet (lowercase), the member's trading wallet. */
  wallet: string | null;
  xUsername: string | null;
  xAvatarUrl: string | null;
}

interface LinkedAccount {
  type?: string;
  address?: string;
  chain_type?: string;
  connector_type?: string;
  wallet_client_type?: string;
  wallet_index?: number;
  username?: string | null;
  profile_picture_url?: string | null;
}

export function profileFromPrivyUser(user: { linked_accounts?: LinkedAccount[] }): PrivyProfile {
  const accounts = user.linked_accounts ?? [];
  const embedded = accounts
    .filter((a) => a.type === 'wallet' && a.chain_type === 'ethereum' && a.connector_type === 'embedded' && a.wallet_client_type === 'privy' && typeof a.address === 'string')
    .sort((a, b) => (a.wallet_index ?? 0) - (b.wallet_index ?? 0))[0];
  const x = accounts.find((a) => a.type === 'twitter_oauth');
  return {
    wallet: embedded?.address?.toLowerCase() ?? null,
    xUsername: x?.username ?? null,
    xAvatarUrl: x?.profile_picture_url ?? null,
  };
}

export async function fetchPrivyProfile(did: string, appId: string, appSecret: string, fetcher: typeof fetch = fetch): Promise<PrivyProfile | null> {
  const res = await fetcher(`https://api.privy.io/v1/users/${encodeURIComponent(did)}`, {
    headers: { authorization: `Basic ${btoa(`${appId}:${appSecret}`)}`, 'privy-app-id': appId },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body) return null;
  return profileFromPrivyUser(body as { linked_accounts?: LinkedAccount[] });
}

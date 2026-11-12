// Random ids, API keys, link codes, nonces and hashing. WebCrypto only, so it runs in Workers and Node.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Lowercase alphanumeric id of a fixed length (unbiased: rejection sampling over 36 symbols). */
export function randomId(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < 252 && out.length < length) out += alphabet[b % 36];
    }
  }
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison of two equal-format strings (hex digests). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const newMemberId = () => `m_${randomId(16)}`;
/** SIWE requires an alphanumeric nonce of at least 8 characters. */
export const newNonce = () => base58(randomBytes(16));
export const newSessionToken = () => `rs_${base58(randomBytes(32))}`;

export interface ApiKey {
  id: string;
  /** The full key the agent stores. Shown once, never persisted. */
  token: string;
  secretHash: string;
}

/** `rk_<8-char id>_<32 random bytes base58>`. Only sha256 of the secret part is stored. */
export async function newApiKey(): Promise<ApiKey> {
  const id = randomId(8);
  const secret = base58(randomBytes(32));
  return { id, token: `rk_${id}_${secret}`, secretHash: await sha256Hex(secret) };
}

export function parseApiKey(token: string): { id: string; secret: string } | null {
  const m = /^rk_([a-z0-9]{8})_([1-9A-HJ-NP-Za-km-z]{30,50})$/.exec(token.trim());
  return m ? { id: m[1]!, secret: m[2]! } : null;
}

export async function newLinkCode(): Promise<{ id: string; code: string; codeHash: string }> {
  const code = `rl_${base58(randomBytes(18))}`;
  return { id: `lc_${randomId(12)}`, code, codeHash: await sha256Hex(code) };
}

export const isLinkCodeFormat = (code: string) => /^rl_[1-9A-HJ-NP-Za-km-z]{20,30}$/.test(code);

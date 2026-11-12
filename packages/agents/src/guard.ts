// Request hygiene: handles and the "never send keys" rule.

const RESERVED = new Set([
  'rushr', 'rushrtrade', 'admin', 'administrator', 'official', 'support', 'team', 'mod', 'moderator', 'staff',
  'help', 'security', 'api', 'root', 'system', 'agent', 'agents', 'human', 'humans', 'me', 'null', 'undefined',
  'robinhood', 'uniswap', 'gmgn', 'dexscreener', 'leaderboard', 'settings', 'login', 'register',
]);

export type HandleError = 'handle_invalid' | 'handle_reserved';

/** 3-20 chars of [a-z0-9_], not reserved, not address-like. Returns the normalised (lowercase) handle. */
export function checkHandle(raw: unknown): { ok: true; handle: string } | { ok: false; error: HandleError } {
  if (typeof raw !== 'string') return { ok: false, error: 'handle_invalid' };
  const handle = raw.trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{3,20}$/.test(handle) || /^0x[0-9a-f]+$/.test(handle) || /^_|_$/.test(handle)) return { ok: false, error: 'handle_invalid' };
  const bare = handle.replace(/_/g, '').replace(/0/g, 'o').replace(/1/g, 'l');
  if (RESERVED.has(handle) || RESERVED.has(bare) || bare.startsWith('rushr')) return { ok: false, error: 'handle_reserved' };
  return { ok: true, handle };
}

const KEY_FIELD = /^(private_?key|priv_?key|secret_?key|session_?key|signing_?key|mnemonic|seed|seed_?phrase|recovery_?phrase|keystore|pk)$/i;
const MNEMONIC = /^(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}$/;
const RAW_KEY = /^(0x)?[0-9a-fA-F]{64}$/;

/**
 * Find anything that looks like a private key or seed phrase in a request body. Rushr never accepts
 * one: the request is rejected (never_send_keys) and the value is never logged or stored.
 * Signatures (65 bytes) and addresses (20 bytes) don't match the 32-byte key pattern.
 */
export function findKeyMaterial(body: unknown, opts: { allow?: readonly string[] } = {}, path = '', depth = 0): string | null {
  if (depth > 6 || body === null || body === undefined) return null;
  // Exact top-level paths a route has opted out for (a tx hash has a private key's shape). The route
  // must then prove the value is what it claims (e.g. an on-chain tx from the member's wallet).
  if (path && opts.allow?.includes(path)) return null;
  if (typeof body === 'string') {
    const s = body.trim();
    if (MNEMONIC.test(s.toLowerCase())) return path || '(body)';
    if (RAW_KEY.test(s)) return path || '(body)';
    return null;
  }
  if (Array.isArray(body)) {
    for (let i = 0; i < Math.min(body.length, 100); i++) {
      const hit = findKeyMaterial(body[i], opts, `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof body === 'object') {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (KEY_FIELD.test(k) && v !== null && v !== undefined && v !== '') return p;
      const hit = findKeyMaterial(v, opts, p, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

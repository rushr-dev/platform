import { toHex, type Address, type Hex } from 'viem';
import { TradeError } from './errors';
import type { TradeConfig } from './config';

/**
 * Session signing for one-click trading (docs/wallets.md). Runs on Cloudflare Workers: fetch + WebCrypto
 * only, no Node built-ins.
 *
 * Gates, all of which must pass before anything is signed:
 * - WALLETS_ENABLED=1 in the environment (off by default);
 * - `assertOneClickAllowed(cfg)`: RushrRouter deployed AND independently audited (founder decision);
 * - the Privy policy attached to our signer (see policy.ts), enforced inside Privy's TEE.
 * Rushr never holds user keys: the user's key lives in Privy's enclave. We hold only an *authorization*
 * key (P-256) that asks Privy to sign within the user-owned policy. That key belongs in a KMS.
 */

// ------------------------------------------------------------------ authorization key (KMS boundary)

/** Signs Privy request payloads with our P-256 authorization key. Implement with a cloud KMS in prod. */
export interface AuthorizationKey {
  /** Signs `payload` (ECDSA P-256 / SHA-256); returns a DER-encoded signature. */
  signDer(payload: Uint8Array): Promise<Uint8Array>;
}

/** Placeholder until the founder picks a KMS (AWS KMS / GCP KMS ECC_NIST_P256). Always refuses. */
export class PlaceholderKmsKey implements AuthorizationKey {
  async signDer(): Promise<Uint8Array> {
    throw new TradeError('CONFIG_INVALID', 'No KMS configured for the Privy authorization key (placeholder)');
  }
}

/**
 * WebCrypto key for local development and tests only (e.g. a key generated in a test, or a Privy
 * dev-environment key in a Worker secret). Production keys belong in a KMS, not in env vars.
 */
export class WebCryptoAuthorizationKey implements AuthorizationKey {
  constructor(private readonly key: CryptoKey) {}

  /** Imports Privy's `wallet-auth:<base64 PKCS#8>` format. */
  static async fromPrivyString(s: string): Promise<WebCryptoAuthorizationKey> {
    const b64 = s.startsWith('wallet-auth:') ? s.slice('wallet-auth:'.length) : s;
    const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return new WebCryptoAuthorizationKey(key);
  }

  async signDer(payload: Uint8Array): Promise<Uint8Array> {
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.key, new Uint8Array(payload)));
    return rawToDer(raw);
  }
}

// ------------------------------------------------------------------ encoding helpers

/** RFC 8785 JSON Canonicalization Scheme (keys sorted by UTF-16 code units, ES number formatting). */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalize: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') throw new Error('canonicalize: bigint (encode as a hex string first)');
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v === undefined ? null : v)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); // JS string comparison is by UTF-16 code units
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  throw new Error(`canonicalize: unsupported ${typeof value}`);
}

/** WebCrypto returns ECDSA signatures as raw r||s (64 bytes); Privy expects DER. */
export function rawToDer(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) throw new Error('rawToDer: expected 64 bytes');
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = Uint8Array.of(0, ...v);
    return Uint8Array.of(0x02, v.length, ...v);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32));
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
}

/** Inverse of rawToDer (for verifying in tests). */
export function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error('derToRaw: not a DER sequence');
  const out = new Uint8Array(64);
  let i = 2;
  for (const off of [0, 32]) {
    if (der[i] !== 0x02) throw new Error('derToRaw: expected INTEGER');
    const len = der[i + 1]!;
    let v = der.slice(i + 2, i + 2 + len);
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    out.set(v, off + 32 - v.length);
    i += 2 + len;
  }
  return out;
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/**
 * Any Privy API request carrying authorization signatures (wallet RPC, wallet/policy updates). Each key
 * signs the RFC 8785 canonical {version, method, url, body, headers}; several signatures are comma
 * separated (Privy's direct implementation). `keys: []` sends no signature header.
 */
export async function signPrivyRequest(p: {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  body: unknown;
  appId: string;
  appSecret: string;
  keys: AuthorizationKey[];
  expiryMs?: number;
  idempotencyKey?: string;
}): Promise<{ url: string; init: RequestInit; signedPayload: string }> {
  const url = p.url.replace(/\/+$/, '');
  const headers: Record<string, string> = { 'privy-app-id': p.appId };
  if (p.expiryMs !== undefined) headers['privy-request-expiry'] = String(p.expiryMs);
  if (p.idempotencyKey) headers['privy-idempotency-key'] = p.idempotencyKey;
  const body = JSON.parse(JSON.stringify(p.body));
  const signedPayload = canonicalize({ version: 1, method: p.method, url, body, headers });
  const sigs = await Promise.all(p.keys.map(async (k) => b64(await k.signDer(new TextEncoder().encode(signedPayload)))));
  return {
    url,
    signedPayload,
    init: {
      method: p.method,
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${btoa(`${p.appId}:${p.appSecret}`)}`,
        ...headers,
        ...(sigs.length ? { 'privy-authorization-signature': sigs.join(',') } : {}),
      },
      body: JSON.stringify(body),
    },
  };
}

// ------------------------------------------------------------------ session signer

/** Unsigned EIP-1559 transaction as Privy's eth_signTransaction expects it (quantities as hex strings). */
export interface SessionTx {
  to: Address;
  data: Hex;
  value: bigint;
  chainId: number;
  nonce?: number;
  gasLimit?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

export interface SessionSigner {
  /** Returns the signed raw transaction (the caller broadcasts it). */
  signTransaction(walletId: string, tx: SessionTx): Promise<Hex>;
}

export interface PrivySignerConfig {
  appId: string;
  /** App secret (Worker secret). Authenticates the app; it cannot sign or change user-owned policies. */
  appSecret: string;
  authorizationKey: AuthorizationKey;
  apiUrl?: string;
  fetch?: typeof fetch;
  /** Seconds a signed request stays valid (privy-request-expiry). */
  requestTtlSeconds?: number;
  now?: () => number;
}

/**
 * Privy REST session signer (POST /v1/wallets/{id}/rpc, eth_signTransaction). The authorization signature
 * follows Privy's documented direct implementation: sign the RFC 8785 canonical JSON of
 * {version:1, method, url, body, headers:{privy-app-id, privy-request-expiry}} with ECDSA P-256 / SHA-256,
 * DER, base64, in `privy-authorization-signature`. Exact header names must be re-checked against Privy's
 * API once the founder's dev app exists (docs.privy.io/controls/authorization-keys).
 */
export class PrivySessionSigner implements SessionSigner {
  private readonly apiUrl: string;
  private readonly f: typeof fetch;

  constructor(private readonly cfg: PrivySignerConfig) {
    this.apiUrl = (cfg.apiUrl ?? 'https://api.privy.io').replace(/\/+$/, '');
    this.f = cfg.fetch ?? fetch;
  }

  /** Builds the request and its authorization signature without sending it (also used by tests). */
  async buildRequest(walletId: string, tx: SessionTx): Promise<{ url: string; init: RequestInit; signedPayload: string }> {
    if (!/^[A-Za-z0-9_-]+$/.test(walletId)) throw new TradeError('CONFIG_INVALID', 'bad wallet id');
    const url = `${this.apiUrl}/v1/wallets/${walletId}/rpc`;
    const q = (v: bigint | number | undefined) => (v === undefined ? undefined : toHex(v));
    const body = {
      method: 'eth_signTransaction',
      params: {
        transaction: {
          to: tx.to,
          data: tx.data,
          value: q(tx.value),
          chain_id: tx.chainId,
          nonce: q(tx.nonce),
          gas_limit: q(tx.gasLimit),
          max_fee_per_gas: q(tx.maxFeePerGas),
          max_priority_fee_per_gas: q(tx.maxPriorityFeePerGas),
          type: 2,
        },
      },
    };
    const now = this.cfg.now?.() ?? Math.floor(Date.now() / 1000);
    return signPrivyRequest({ method: 'POST', url, body, appId: this.cfg.appId, appSecret: this.cfg.appSecret, keys: [this.cfg.authorizationKey], expiryMs: (now + (this.cfg.requestTtlSeconds ?? 60)) * 1000 });
  }

  async signTransaction(walletId: string, tx: SessionTx): Promise<Hex> {
    const { url, init } = await this.buildRequest(walletId, tx);
    const r = await this.f(url, init);
    const text = await r.text();
    if (!r.ok) {
      // A policy denial comes back here: surface it as such, never retry around it.
      // Live Privy (2026-11-12): HTTP 400 {"error":"RPC request denied due to policy violation","code":"policy_violation"}.
      const denied = /policy_violation/.test(text) || r.status === 403 || /polic/i.test(text);
      throw new TradeError(denied ? 'SIMULATION_REVERTED' : 'RPC_ERROR', `Privy ${denied ? 'policy denied' : 'error'} (${r.status}): ${text.slice(0, 200)}`);
    }
    const j = JSON.parse(text) as { data?: { signed_transaction?: Hex } };
    const signed = j.data?.signed_transaction;
    if (!signed?.startsWith('0x')) throw new TradeError('RPC_ERROR', 'Privy response had no signed_transaction');
    return signed;
  }
}

// ------------------------------------------------------------------ gates

export interface WalletEnv {
  WALLETS_ENABLED?: string;
  PRIVY_APP_ID?: string;
  PRIVY_APP_SECRET?: string;
}

/**
 * Returns a session signer only when WALLETS_ENABLED=1 and Privy is configured; null otherwise (the app
 * then falls back to wallet-confirmed trades). The authorization key comes from the KMS adapter.
 */
export function createSessionSigner(env: WalletEnv, authorizationKey: AuthorizationKey, opts: Partial<PrivySignerConfig> = {}): SessionSigner | null {
  if (env.WALLETS_ENABLED !== '1') return null;
  if (!env.PRIVY_APP_ID || !env.PRIVY_APP_SECRET) return null;
  return new PrivySessionSigner({ ...opts, appId: env.PRIVY_APP_ID, appSecret: env.PRIVY_APP_SECRET, authorizationKey });
}

/** One-click (server-signed) trading needs RushrRouter deployed AND audited, plus a real treasury. */
export function assertOneClickAllowed(cfg: TradeConfig): void {
  if (!cfg.rushrRouter) throw new TradeError('UNSUPPORTED_VENUE', 'One-click trading needs RushrRouter deployed');
  if (!cfg.rushrRouterAudited) throw new TradeError('UNSUPPORTED_VENUE', 'One-click trading stays off until RushrRouter is independently audited');
}

import { isAddress, type Address, type Hex } from 'viem';
import { TRADE_ADDRESSES } from './addresses';
import { v4PoolId } from './math';
import type { QuoteAsset } from './types';
import type { PoolKey } from './universal-router';

/**
 * Adapter for the Rushr indexer's `GET /tokens/:a/pools` (added in 0c61362).
 * Response: `{ pools: ApiPoolRow[] }`, busiest first. Keys come from Initialize events, so hook-managed
 * v4 pools (Doppler) resolve without any RPC on our side. Until the endpoint is deployed, callers get
 * `null` and discovery falls back to on-chain lookups plus `main_pool`.
 */
export interface ApiPoolRow {
  /** v4 pool id (bytes32), v3/v2 pool address or PONS curve address. */
  pool: string;
  /** uniswap | ramses | aero | up | topaz | nami | giga | robinswap | other | pons */
  dex: string;
  version: 'v4' | 'v3' | 'v2' | 'curve' | string;
  launchpad: string | null;
  quote: string;
  token_is_currency0: boolean;
  /** null for curves; fee/tickSpacing null for v2; hooks null for v3/v2. fee 0x800000 = v4 dynamic fee. */
  key: { currency0: string; currency1: string; fee: number | null; tickSpacing: number | null; hooks: string | null } | null;
  liquidity_usd: number | null;
  liquidity_at?: string | null;
  volume_24h_usd: number;
  trades_24h: number;
  created_at: string;
}

export interface ApiPoolHints {
  /** Verified v4 keys for the chosen quote asset (pool id recomputed and checked). */
  v4Keys: PoolKey[];
  /** True when the API lists a PONS curve for the token. */
  hasCurve: boolean;
  /** Pools with real volume we can't route yet (other v3/v2 forks), busiest first, for disclosure. */
  unroutable: { pool: string; dex: string; version: string; volume24hUsd: number }[];
  /** Rows dropped because their key didn't hash to their pool id (never trusted for routing). */
  rejected: string[];
}

const lc = (a: string) => a.toLowerCase() as Address;

/** Accepts the endpoint body (`{ pools }`) or a bare array; drops malformed rows. */
export function parseApiPools(body: unknown): ApiPoolRow[] {
  const rows = Array.isArray(body) ? body : (body as { pools?: unknown } | null)?.pools;
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (r): r is ApiPoolRow => !!r && typeof r === 'object' && typeof (r as ApiPoolRow).pool === 'string' && typeof (r as ApiPoolRow).version === 'string',
  );
}

/** Pool-side quote currencies serving a user-facing quote asset (native ETH and WETH for ETH). */
function quotesFor(asset: QuoteAsset): Set<string> {
  return new Set<string>(asset === 'ETH' ? [TRADE_ADDRESSES.eth, TRADE_ADDRESSES.weth] : [TRADE_ADDRESSES.usdg]);
}

/**
 * Turns API rows into discovery hints. v4 keys are only trusted if keccak256(abi.encode(key)) equals the
 * row's pool id, so a bad or tampered API response can't point a swap at a different pool.
 */
export function hintsFromApiPools(rows: ApiPoolRow[], quoteAsset: QuoteAsset): ApiPoolHints {
  const quotes = quotesFor(quoteAsset);
  const out: ApiPoolHints = { v4Keys: [], hasCurve: false, unroutable: [], rejected: [] };
  for (const r of rows) {
    if (r.version === 'curve') {
      out.hasCurve = true;
      continue;
    }
    if (!quotes.has(lc(r.quote))) continue;
    if (r.version === 'v4') {
      const k = r.key;
      if (!k || k.fee == null || k.tickSpacing == null || !isAddress(k.currency0, { strict: false }) || !isAddress(k.currency1, { strict: false })) {
        out.rejected.push(r.pool);
        continue;
      }
      const key: PoolKey = { currency0: lc(k.currency0), currency1: lc(k.currency1), fee: k.fee, tickSpacing: k.tickSpacing, hooks: lc(k.hooks ?? TRADE_ADDRESSES.eth) };
      if (v4PoolId(key) !== (r.pool.toLowerCase() as Hex)) {
        out.rejected.push(r.pool);
        continue;
      }
      out.v4Keys.push(key);
    } else if ((r.version === 'v3' || r.version === 'v2') && r.dex !== 'uniswap') {
      // The Universal Router only knows Uniswap's own v2/v3 factories; Uniswap v2/v3 pools are found on-chain.
      if (r.volume_24h_usd > 0) out.unroutable.push({ pool: r.pool, dex: r.dex, version: r.version, volume24hUsd: r.volume_24h_usd });
    }
  }
  return out;
}

/** Fetches pool rows; null when the endpoint is missing (not deployed yet) or fails. Never throws. */
export async function fetchApiPools(token: Address, opts: { apiUrl?: string; fetch?: typeof fetch } = {}): Promise<ApiPoolRow[] | null> {
  const f = opts.fetch ?? fetch;
  try {
    const r = await f(`${opts.apiUrl ?? 'https://api.rushr.trade'}/tokens/${token.toLowerCase()}/pools`);
    if (!r.ok) {
      await r.body?.cancel().catch(() => undefined);
      return null;
    }
    return parseApiPools(await r.json());
  } catch {
    return null;
  }
}

/** One-line disclosure for liquidity we can't route through yet. */
export function unroutableNote(h: ApiPoolHints): string | null {
  if (!h.unroutable.length) return null;
  const venues = [...new Set(h.unroutable.map((u) => u.dex))];
  const usd = h.unroutable.reduce((a, u) => a + u.volume24hUsd, 0);
  return `Not routed yet: ${venues.join(', ')} pools (~$${Math.round(usd).toLocaleString('en-US')} 24h volume). Quotes cover Uniswap v2/v3/v4 and PONS curves.`;
}

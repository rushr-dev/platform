/** Server-side reads from the Rushr indexer API. Every call degrades to null so pages still render. */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'https://api.rushr.trade';

export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export interface TokenCard {
  address: string;
  symbol: string;
  name: string;
  launchpad: string | null;
  status: 'new' | 'bonding' | 'migrated';
  created_at: string;
  market_cap_usd: number | null;
  volume_24h_usd: number | null;
  holders: number;
  bonding_progress: number | null;
  risk: RiskLevel | null;
  verdict: string | null;
  top10_pct: number | null;
  dev_pct: number | null;
  bundled_pct: number | null;
  snipers_pct: number | null;
  insiders_pct: number | null;
  fresh_pct: number | null;
  airdropped: number | null;
  copycat: boolean | null;
  serial_launcher: boolean | null;
  /** Airdrop-farm clone (plain pool, padded holder count). Hidden in the terminal by default. */
  spam?: boolean | null;
  image_url?: string | null;
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  price_usd?: number | null;
  ath_market_cap_usd?: number | null;
  migrated_at?: string | null;
  /** Sum of the pools the API has measured (v3/v2 today); absent before the pools API deploy. */
  liquidity_usd?: number | null;
  // Trenches card fields requested from Data (requests to Data). All optional: the
  // cards hide whatever isn't there yet.
  /** Transfer tax in percent (the larger of buy/sell when they differ). */
  tax_pct?: number | null;
  buy_tax_pct?: number | null;
  sell_tax_pct?: number | null;
  /** Quote asset symbol (WETH, USDG, MSTR…); the card falls back to the `quote` address. */
  quote_symbol?: string | null;
  /** Buys and sells in the last 24h. */
  buys_24h?: number | null;
  sells_24h?: number | null;
  /** The creator's X handle, without @. */
  creator_x?: string | null;
  /** Fees paid in the last 24h, USD. */
  fees_24h_usd?: number | null;
  /** Market cap at launch: shown until the first trade gives a live one. */
  initial_market_cap_usd?: number | null;
  // Data's names (1863313): taxes in basis points, fees paid, 24h trade count, the token's X handle.
  buy_tax_bps?: number | null;
  sell_tax_bps?: number | null;
  fees_paid_usd?: number | null;
  trades_24h?: number | null;
  twitter_handle?: string | null;
  /** Rushr quote token address (0x0 = native ETH). */
  quote?: string | null;
  /** Block time (unix seconds) of the trade that triggered a live update. */
  block_time?: number | null;
}

export interface SignalReason {
  text: string;
  level: 'high' | 'medium' | 'low' | 'info';
}

export interface TokenDetail extends TokenCard {
  deployer: string;
  total_supply: string;
  decimals: number;
  created_block: string;
  launch_indexed: boolean;
  description: string | null;
  signals: {
    reasons?: SignalReason[];
    sniperCount?: number;
    dev?: { launches: number; launches7d: number; rugs: number; migrated: number; serialLauncher: boolean; bestAthMarketCapUsd: number | null };
  } | null;
  dev: { launches: number; launches_7d: number; rugs: number; migrated: number; best_peak_mcap_usd: string | null } | null;
  trades_24h: number;
  /** v4 pool id (bytes32) or pool/curve address. */
  main_pool?: string | null;
  quote?: string | null;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades?: number;
}

export interface Stats {
  tokens_tracked: number;
  launches_24h: number;
  safety_checks: number;
  flagged_high_risk: number;
  trades_24h: number;
}

/** Server reads give up after `timeoutMs` so a slow API never holds the page hostage. */
async function get<T>(path: string, revalidate: number, timeoutMs = 6_000): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}${path}`, { next: { revalidate }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const getStats = () => get<Stats>('/stats', 30);
export const getToken = (address: string) => get<TokenCard>(`/tokens/${address}`, 60);

export interface Trade {
  tx: string;
  log_index: number;
  time: string;
  trader: string;
  side: 'buy' | 'sell';
  price_usd: number | null;
  usd: number | null;
  token_amount?: string;
  quote?: string;
  quote_amount?: string;
}

export const getColumn = async (column: 'new' | 'almost' | 'migrated', limit = 8, revalidate = 30, extra = '') =>
  ((await get<{ tokens: (TokenCard | null)[] }>(`/tokens?column=${column}&limit=${limit}${extra}`, revalidate))?.tokens ?? []).filter(
    (t): t is TokenCard => t != null,
  );

export const getTrades = async (address: string, limit = 200, revalidate = 60) =>
  (await get<{ trades: Trade[] }>(`/tokens/${address}/trades?limit=${limit}`, revalidate))?.trades ?? [];

export type Column = 'new' | 'almost' | 'migrated';

/** A token the API is still fetching from chain (HTTP 202): follow `token:<a>` on the feed. */
export interface PendingToken {
  pending: true;
  address: string;
  state: 'hydrating' | 'busy' | string;
}

/**
 * Token page detail. 200 → the detail; 202 → pending (the API started fetching it from chain);
 * 404 or an error → null.
 */
export async function getTokenDetail(address: string): Promise<TokenDetail | PendingToken | null> {
  try {
    const res = await fetch(`${API_URL}/tokens/${address}`, { next: { revalidate: 0 }, signal: AbortSignal.timeout(6_000) });
    if (res.status === 202) {
      const body = (await res.json().catch(() => ({}))) as { state?: string };
      return { pending: true, address, state: body.state ?? 'hydrating' };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return (await res.json()) as TokenDetail;
  } catch {
    return null;
  }
}

export const isPending = (t: TokenDetail | PendingToken | null): t is PendingToken => !!t && 'pending' in t;

export const getCandles = async (address: string, interval = '1m', hours = 24) =>
  (await get<{ candles: Candle[] }>(`/tokens/${address}/candles?interval=${interval}&hours=${hours}`, 0))?.candles ?? [];

/** Robinhood's tokenized stocks from the indexer's GET /stocks (apps/indexer/src/stocks.ts). */
import { API_URL } from './api';

export interface StockRow {
  address: string;
  symbol: string;
  /** Company or fund name, without " • Robinhood Token". */
  company: string;
  name: string;
  image_url: string | null;
  price_usd: number | null;
  /** Null while our price history of the stock is younger than 24h. */
  change_24h_pct: number | null;
  market_cap_usd: number | null;
  volume_24h_usd: number | null;
  liquidity_usd: number | null;
  holders: number;
  /** Hourly closes over the last 24h, oldest first. */
  spark: number[];
}

export interface PairedRow {
  address: string;
  symbol: string;
  name: string;
  image_url: string | null;
  launchpad: string | null;
  market_cap_usd: number | null;
  volume_24h_usd: number | null;
  holders: number;
}

export interface StocksData {
  featured: string;
  stocks: StockRow[];
  paired: PairedRow[];
}

export const STOCKS_REFRESH_MS = 30_000;

/** Server or browser read; null on any error so the page still renders. */
export async function getStocks(revalidate = 30): Promise<StocksData | null> {
  try {
    const res = await fetch(`${API_URL}/stocks`, { next: { revalidate }, signal: AbortSignal.timeout(6_000) });
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    return (await res.json()) as StocksData;
  } catch {
    return null;
  }
}

/** Stock prices: $90.07, $1,357.55. */
export const stockPrice = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) || n <= 0 ? '—' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

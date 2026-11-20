import type { Sql } from 'postgres';
import { FEATURED_STOCK, STOCK_DEPLOYERS, STOCK_NAME_SUFFIX, stockCompanyName } from '@rushr/core';

/**
 * GET /stocks: Robinhood's tokenized stocks (see packages/core/src/stocks.ts for how they are recognised),
 * the featured one, and memecoins whose market is priced in the featured stock (e.g. coins paired with ANT).
 */

export const STOCKS_CACHE_S = 30;

export interface StockRow {
  address: string;
  symbol: string;
  /** Company or fund name, without " • Robinhood Token". */
  company: string;
  name: string;
  image_url: string | null;
  price_usd: number | null;
  /** Against the price 24h ago (see the query); null while our history of the stock is younger than 24h. */
  change_24h_pct: number | null;
  market_cap_usd: number | null;
  volume_24h_usd: number | null;
  liquidity_usd: number | null;
  holders: number;
  /** Hourly median closes over the last 24h, oldest first, bad prints removed, for sparklines. */
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

export interface StocksResponse {
  featured: string;
  stocks: StockRow[];
  /** Memecoins priced in the featured stock, biggest first (spam and stock look-alikes left out). */
  paired: PairedRow[];
}

type Raw = Omit<StockRow, 'company' | 'change_24h_pct' | 'spark'> & { open_24h: number | null; spark: number[] | null };

/** Rows from the query → API rows: company name, 24h change, empty sparklines as []. */
export function shapeStocks(rows: Raw[]): StockRow[] {
  return rows.map(({ open_24h, spark, ...r }) => {
    const change = open_24h && r.price_usd ? ((r.price_usd - open_24h) / open_24h) * 100 : null;
    return { ...r, company: stockCompanyName(r.name), change_24h_pct: change, spark: dropOutliers(spark ?? []) };
  });
}

/**
 * Hourly points far from the day's median (over 25% off) are bad prints, not a stock's real move: the first
 * hour after we began indexing a pool can carry swaps at stale or wild prices (ANT, 2026-11-19: $412 against ~$95).
 */
export function dropOutliers(points: number[], maxOff = 0.25): number[] {
  if (points.length < 3) return points;
  const sorted = [...points].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  return points.filter((p) => Math.abs(p - median) <= median * maxOff);
}

export async function stocksList(sql: Sql): Promise<StocksResponse> {
  const rows = await sql<Raw[]>`
    select t.address, t.symbol, t.name, t.image_url, t.price_usd::float8 as price_usd, t.market_cap_usd::float8 as market_cap_usd,
      t.volume_24h_usd::float8 as volume_24h_usd, coalesce(t.holders, 0)::int as holders,
      (select sum(p.liquidity_usd) from pools p where p.token = t.address)::float8 as liquidity_usd,
      -- The price 24h ago: the median 1m close of the hour before the mark (one bad print can't move it), else
      -- the last close before it (quiet stocks), at most a week old. Null when our history is younger than 24h.
      coalesce(
        (select percentile_cont(0.5) within group (order by c.close) from candles c where c.token = t.address and c.interval = '1m'
           and c.bucket <= now() - interval '24 hours' and c.bucket > now() - interval '25 hours'),
        (select c.close from candles c where c.token = t.address and c.interval = '1m'
           and c.bucket <= now() - interval '24 hours' and c.bucket > now() - interval '8 days'
         order by c.bucket desc limit 1))::float8 as open_24h,
      (select json_agg(h.close order by h.b) from (
         select date_bin('1 hour', c.bucket, timestamptz '2020-01-01') as b, (percentile_cont(0.5) within group (order by c.close))::float8 as close
         from candles c where c.token = t.address and c.interval = '1m' and c.bucket > now() - interval '24 hours'
         group by 1) h) as spark
    from tokens t
    where t.deployer = any(${STOCK_DEPLOYERS}) and right(t.name, ${STOCK_NAME_SUFFIX.length}) = ${STOCK_NAME_SUFFIX}
    order by t.volume_24h_usd desc nulls last, t.market_cap_usd desc nulls last`;
  const paired = await sql<PairedRow[]>`
    select t.address, t.symbol, t.name, t.image_url, t.launchpad, t.market_cap_usd::float8 as market_cap_usd,
      t.volume_24h_usd::float8 as volume_24h_usd, coalesce(t.holders, 0)::int as holders
    from tokens t left join signals s on s.token = t.address
    where t.quote = ${FEATURED_STOCK}
      and not coalesce((s.data->>'spam')::bool, false)
      -- Look-alikes of the stock itself ("ANT", "Anthropic") would read as the real thing here.
      and upper(t.symbol) <> (select upper(symbol) from tokens where address = ${FEATURED_STOCK})
      and t.name not ilike '%robinhood token%'
      and coalesce(t.holders, 0) >= 10
    order by t.market_cap_usd desc nulls last
    limit 6`;
  return { featured: FEATURED_STOCK, stocks: shapeStocks(rows), paired };
}

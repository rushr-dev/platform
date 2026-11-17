// A wallet's PnL over time and its trade list, for the profile page. Both read the swaps the wallet made:
// each sell carries the realized PnL that positions computed for it (average cost, see pipeline.ts), so the
// running sum here matches the wallet's realized PnL summary.
import type { Sql } from 'postgres';

export type PnlRange = '24h' | '7d' | '30d' | 'all';
export const PNL_RANGES: PnlRange[] = ['24h', '7d', '30d', 'all'];
const RANGE_MS: Record<Exclude<PnlRange, 'all'>, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };
/** Most points a chart gets: sells beyond this are thinned evenly (the last one always kept). */
const MAX_POINTS = 400;

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Keep at most `max` points, evenly spaced, always including the last (pure; exported for tests). */
export function thin<T>(pts: T[], max = MAX_POINTS): T[] {
  if (pts.length <= max) return pts;
  const step = pts.length / max;
  const out: T[] = [];
  for (let i = 0; i < max - 1; i++) out.push(pts[Math.floor(i * step)]!);
  out.push(pts.at(-1)!);
  return out;
}

/**
 * Cumulative realized PnL within the range: one point per sell (unix seconds, USD), starting from $0 at
 * the range's start (or the wallet's first sell for `all`).
 */
export async function walletPnlHistory(sql: Sql, wallet: string, range: PnlRange, now = Date.now()) {
  const since = range === 'all' ? null : new Date(now - RANGE_MS[range]);
  const rows = await sql<{ time: Date; realized: number }[]>`
    select time, realized_usd::float8 as realized from swaps
    where trader = ${wallet} and side = 'sell' and realized_usd is not null ${since ? sql`and time >= ${since}` : sql``}
    order by time, log_index
    limit 20000`;
  let sum = 0;
  const points = rows.map((r) => {
    sum += r.realized;
    return { t: Math.floor(r.time.getTime() / 1000), pnl: round2(sum) };
  });
  return { range, from: since ? Math.floor(since.getTime() / 1000) : (points[0]?.t ?? null), realizedUsd: round2(sum), sells: rows.length, points: thin(points) };
}

/**
 * The wallet's trades, newest first: token, side, size in USD and tokens, price, the token's market cap
 * at that price (on today's supply) and, for sells, the realized PnL. `before` (unix seconds) pages back.
 */
export async function walletTrades(sql: Sql, wallet: string, opts: { limit: number; before?: number | null }) {
  const before = opts.before ? new Date(opts.before * 1000) : null;
  const rows = await sql<{
    tx: string; log_index: number; time: Date; token: string; symbol: string | null; image_url: string | null; decimals: number;
    side: 'buy' | 'sell'; token_amount: string; usd: number | null; price_usd: number | null; mcap_usd: number | null; realized_usd: number | null;
  }[]>`
    select s.tx, s.log_index, s.time, s.token, t.symbol, t.image_url, t.decimals, s.side, s.token_amount::text,
      s.usd::float8 as usd, s.price_usd::float8 as price_usd,
      (s.price_usd * t.total_supply / power(10::numeric, t.decimals))::float8 as mcap_usd,
      s.realized_usd::float8 as realized_usd
    from swaps s join tokens t on t.address = s.token
    where s.trader = ${wallet} ${before ? sql`and s.time < ${before}` : sql``}
    order by s.time desc, s.log_index desc
    limit ${opts.limit + 1}`;
  const page = rows.slice(0, opts.limit);
  return {
    trades: page.map((r) => ({
      tx: r.tx, logIndex: r.log_index, time: Math.floor(r.time.getTime() / 1000), token: r.token, symbol: r.symbol, imageUrl: r.image_url,
      decimals: r.decimals, side: r.side, tokenAmount: r.token_amount, usd: r.usd, priceUsd: r.price_usd, mcapUsd: r.mcap_usd,
      realizedUsd: r.side === 'sell' ? r.realized_usd : null,
    })),
    nextBefore: rows.length > opts.limit ? Math.floor(page.at(-1)!.time.getTime() / 1000) : null,
  };
}

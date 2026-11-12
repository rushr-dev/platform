import type { Sql } from 'postgres';
import { Rpc } from './rpc';

/**
 * Reads shared by the HTTP API and the realtime gateways (snapshots). Shapes follow docs/realtime.md.
 */

/** Fields every token card needs (trenches columns, search, live updates). */
export async function tokenSummaries(sql: Sql, where: { addresses?: string[] } = {}) {
  return sql`
    select t.address, t.symbol, t.name, t.image_url, t.website, t.twitter, t.telegram, t.launchpad, t.status, t.quote, t.created_at, t.migrated_at,
      t.price_usd::float8 as price_usd, t.market_cap_usd::float8 as market_cap_usd,
      t.ath_market_cap_usd::float8 as ath_market_cap_usd, t.volume_24h_usd::float8 as volume_24h_usd,
      t.holders, t.bonding_progress::float8 as bonding_progress,
      (select sum(p.liquidity_usd) from pools p where p.token = t.address)::float8 as liquidity_usd,
      s.risk_level as risk, s.verdict,
      (s.data->>'top10Pct')::float8 as top10_pct, (s.data->>'devPct')::float8 as dev_pct,
      (s.data->>'bundledPct')::float8 as bundled_pct, (s.data->>'snipersPct')::float8 as snipers_pct,
      (s.data->>'insidersPct')::float8 as insiders_pct, (s.data->>'freshWalletsPct')::float8 as fresh_pct,
      (s.data->>'airdroppedHolders')::int as airdropped, (s.data->>'copycat')::bool as copycat,
      (s.data->'dev'->>'serialLauncher')::bool as serial_launcher, coalesce((s.data->>'spam')::bool, false) as spam
    from tokens t left join signals s on s.token = t.address
    where t.address = any(${where.addresses ?? []})`;
}

/** Launchpads whose tokens trade on a bonding curve before graduating. */
export const CURVE_LAUNCHPADS = ['pons', 'liftfun'];
/** Bonding progress at which a curve token moves from New to Almost bonded. */
export const ALMOST_BONDED = 0.5;

export type Column = 'new' | 'almost' | 'migrated';
export const COLUMNS: Column[] = ['new', 'almost', 'migrated'];

/**
 * Which trenches column a card belongs to (same rules as the list query), or null when the default
 * trenches hide it (plain-pool tokens and spam are opt-in).
 */
export function columnOf(card: { status?: unknown; launchpad?: unknown; bonding_progress?: unknown; spam?: unknown }): Column | null {
  if (card.launchpad === 'uniswap-v4' || card.spam === true) return null;
  if (card.status === 'migrated') return 'migrated';
  const almost = CURVE_LAUNCHPADS.includes(String(card.launchpad)) && Number(card.bonding_progress ?? 0) >= ALMOST_BONDED;
  return almost ? 'almost' : 'new';
}

export interface TrenchesQuery {
  column: string;
  limit: number;
  minMcap: number;
  maxMcap: number;
  maxAgeMin: number;
  minHolders: number;
  launchpad: string | null;
  hideHighRisk: boolean;
  showSpam: boolean;
  /** Like GMGN, the trenches list launchpad tokens; plain pools (where nearly all clones live) are opt-in. */
  showPlain: boolean;
}

export const TRENCHES_DEFAULTS: TrenchesQuery = {
  column: 'new', limit: 50, minMcap: 0, maxMcap: 1e15, maxAgeMin: 7 * 24 * 60, minHolders: 0,
  launchpad: null, hideHighRisk: false, showSpam: false, showPlain: false,
};

/** Trenches columns. new / almost (bonding) / migrated, with GMGN-style filters. */
export async function trenchesList(sql: Sql, q: TrenchesQuery) {
  // Almost bonded = launchpad tokens still on their bonding curve and at least halfway there,
  // like GMGN. Plain-pool tokens have no curve, so they never land here (whatever their market cap).
  const almost = sql`(t.launchpad = any(${CURVE_LAUNCHPADS}) and coalesce(t.bonding_progress, 0) >= ${ALMOST_BONDED})`;
  const columnWhere =
    q.column === 'migrated'
      ? sql`t.status = 'migrated'`
      : q.column === 'almost'
        ? sql`t.status <> 'migrated' and ${almost}`
        : sql`t.status <> 'migrated' and not ${almost}`;
  const order =
    q.column === 'migrated'
      ? sql`coalesce(t.migrated_at, t.created_at) desc`
      : q.column === 'almost'
        ? sql`t.bonding_progress desc nulls last, t.market_cap_usd desc nulls last`
        : sql`t.created_at desc`;
  const rows = await sql<{ address: string }[]>`
    select t.address from tokens t left join signals s on s.token = t.address
    where ${columnWhere}
      and coalesce(t.market_cap_usd, 0) between ${q.minMcap} and ${q.maxMcap}
      and t.created_at > now() - ${q.maxAgeMin} * interval '1 minute'
      and t.holders >= ${q.minHolders}
      and (${q.launchpad}::text is null or t.launchpad = ${q.launchpad})
      and (${!q.hideHighRisk} or coalesce(s.risk_level, 'unknown') <> 'high')
      and (${q.showSpam} or not coalesce((s.data->>'spam')::bool, false))
      and (${q.showPlain} or t.launchpad <> 'uniswap-v4')
    order by ${order}
    limit ${q.limit}`;
  const summaries = await tokenSummaries(sql, { addresses: rows.map((r) => r.address) });
  const byAddr = new Map(summaries.map((s) => [s.address, s]));
  return rows.map((r) => byAddr.get(r.address)).filter(Boolean);
}

/** Re-measure a v3/v2 pool's TVL (its token balances) at most this often; reads are on demand, per page view. */
export const POOL_TVL_TTL_S = 30;
const NATIVE = '0x0000000000000000000000000000000000000000';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

/**
 * Every pool of a token we index, busiest first, with its routing key (Universal Router needs
 * currency0/currency1/fee/tickSpacing/hooks for v4, fee for v3), 24h volume and liquidity.
 * Liquidity: v3/v2 = the pool's token balances (matches DexScreener), refreshed on read every 30s.
 * v4 pools share the PoolManager's balance, so their liquidity is null for now.
 */
export async function tokenPools(sql: Sql, rpcUrl: string, token: string) {
  const [t] = await sql<{ decimals: number; price_usd: string | null }[]>`select decimals, price_usd from tokens where address = ${token}`;
  if (!t) return null;
  const pools = await sql<
    { id: string; dex: string; venue: string | null; quote: string; token_is_currency0: boolean; fee: number | null; tick_spacing: number | null;
      hooks: string | null; launchpad: string | null; liquidity_usd: string | null; liquidity_at: Date | null; created_at: Date }[]
  >`select id, dex, venue, quote, token_is_currency0, fee, tick_spacing, hooks, launchpad, liquidity_usd, liquidity_at, created_at
    from pools where token = ${token}`;
  const vol = new Map(
    (await sql<{ pool: string; usd: number; n: number }[]>`
      select pool, coalesce(sum(usd), 0)::float8 as usd, count(*)::int as n from swaps
      where token = ${token} and time > now() - interval '24 hours' group by pool`).map((r) => [r.pool, r]),
  );

  // Refresh stale v3/v2 TVL in one batched RPC call.
  const stale = pools.filter((p) => (p.dex === 'v3' || p.dex === 'v2') && (!p.liquidity_at || Date.now() - p.liquidity_at.getTime() > POOL_TVL_TTL_S * 1000));
  if (stale.length && t.price_usd) {
    const quotes = [...new Set(stale.map((p) => p.quote))];
    const qrows = await sql<{ address: string; decimals: number; price_usd: string | null }[]>`
      select address, decimals, price_usd from tokens where address = any(${quotes})`;
    const [eth] = await sql<{ value: { usd: number } }[]>`select value from indexer_state where key = 'eth_usd'`;
    const quoteInfo = (q: string): { decimals: number; usd: number | null } => {
      if (q === USDG) return { decimals: 6, usd: 1 };
      if (q === WETH || q === NATIVE) return { decimals: 18, usd: eth?.value.usd ?? null };
      const r = qrows.find((x) => x.address === q);
      return { decimals: r?.decimals ?? 18, usd: r?.price_usd ? Number(r.price_usd) : null };
    };
    try {
      const bal = await new Rpc(rpcUrl).balances(stale.flatMap((p) => [{ token, holder: p.id }, { token: p.quote, holder: p.id }]));
      const now = new Date();
      for (const [i, p] of stale.entries()) {
        const tb = bal[i * 2];
        const qb = bal[i * 2 + 1];
        const q = quoteInfo(p.quote);
        if (tb == null || qb == null || q.usd == null) continue;
        const usd = (Number(tb) / 10 ** t.decimals) * Number(t.price_usd) + (Number(qb) / 10 ** q.decimals) * q.usd;
        p.liquidity_usd = String(usd);
        p.liquidity_at = now;
        await sql`update pools set liquidity_usd = ${usd}, liquidity_at = ${now} where id = ${p.id}`;
      }
    } catch (err) {
      console.error('pool tvl refresh failed', token, err);
    }
  }

  const version = (dex: string) => (dex === 'uniswap-v4' ? 'v4' : dex === 'pons-curve' ? 'curve' : dex);
  const rows = pools.map((p) => {
    const [c0, c1] = p.token_is_currency0 ? [token, p.quote] : [p.quote, token];
    const routable = p.dex === 'uniswap-v4' || p.dex === 'v3' || p.dex === 'v2';
    return {
      pool: p.id,
      dex: p.venue ?? (p.dex === 'uniswap-v4' ? 'uniswap' : p.dex === 'pons-curve' ? 'pons' : p.dex),
      version: version(p.dex),
      launchpad: p.launchpad,
      quote: p.quote,
      token_is_currency0: p.token_is_currency0,
      key: routable ? { currency0: c0, currency1: c1, fee: p.fee, tickSpacing: p.tick_spacing, hooks: p.dex === 'uniswap-v4' ? (p.hooks ?? NATIVE) : null } : null,
      liquidity_usd: p.liquidity_usd == null ? null : Number(p.liquidity_usd),
      liquidity_at: p.liquidity_at,
      volume_24h_usd: vol.get(p.id)?.usd ?? 0,
      trades_24h: vol.get(p.id)?.n ?? 0,
      created_at: p.created_at,
    };
  });
  rows.sort((a, b) => b.volume_24h_usd - a.volume_24h_usd || (b.liquidity_usd ?? 0) - (a.liquidity_usd ?? 0));
  // Old tokens collect hundreds of empty spam pools (PONS: 872 v4 pools, 27 ever traded): list the ones
  // with activity or liquidity, plus pools created in the last day, at most 50.
  const dayAgo = Date.now() - 24 * 3600_000;
  return rows.filter((r) => r.trades_24h > 0 || (r.liquidity_usd ?? 0) > 0 || r.created_at.getTime() > dayAgo || rows.length <= 10).slice(0, 50);
}

export interface Window {
  priceChangePct: number | null;
  volumeUsd: number;
  buys: number;
  sells: number;
  buyUsd: number;
  sellUsd: number;
  makers: number;
}
export type Stats = { '5m': Window; '1h': Window; '6h': Window; '24h': Window; asOf: number };
const WINDOWS = { '5m': '5 minutes', '1h': '1 hour', '6h': '6 hours', '24h': '24 hours' } as const;

/** 5m/1h/6h/24h windows for several tokens in one query (index: swaps(token, time)). */
export async function tokenStats(sql: Sql, tokens: string[]): Promise<Map<string, Stats>> {
  const out = new Map<string, Stats>();
  if (!tokens.length) return out;
  const parts = Object.entries(WINDOWS).map(
    ([k, iv]) => sql`
      , count(*) filter (where s.side = 'buy' and s.time > now() - ${iv}::interval)::int as ${sql(`${k}_buys`)}
      , count(*) filter (where s.side = 'sell' and s.time > now() - ${iv}::interval)::int as ${sql(`${k}_sells`)}
      , coalesce(sum(s.usd) filter (where s.side = 'buy' and s.time > now() - ${iv}::interval), 0)::float8 as ${sql(`${k}_buy_usd`)}
      , coalesce(sum(s.usd) filter (where s.side = 'sell' and s.time > now() - ${iv}::interval), 0)::float8 as ${sql(`${k}_sell_usd`)}
      , count(distinct s.trader) filter (where s.time > now() - ${iv}::interval)::int as ${sql(`${k}_makers`)}
      , ((array_agg(s.price_usd order by s.block, s.log_index) filter (where s.time > now() - ${iv}::interval and s.price_usd is not null))[1])::float8 as ${sql(`${k}_open`)}`,
  );
  const rows = await sql<Record<string, number | string | null>[]>`
    select s.token ${parts.reduce((a, p) => sql`${a} ${p}`, sql``)},
      (select price_usd from tokens t where t.address = s.token)::float8 as price
    from swaps s where s.token = any(${tokens}) and s.time > now() - interval '24 hours'
    group by s.token`;
  const asOf = Math.floor(Date.now() / 1000);
  for (const r of rows) {
    const w = (k: keyof typeof WINDOWS): Window => {
      const open = r[`${k}_open`] as number | null;
      const price = r.price as number | null;
      const buyUsd = r[`${k}_buy_usd`] as number;
      const sellUsd = r[`${k}_sell_usd`] as number;
      return {
        priceChangePct: open && price ? ((price - open) / open) * 100 : null,
        volumeUsd: buyUsd + sellUsd, buys: r[`${k}_buys`] as number, sells: r[`${k}_sells`] as number,
        buyUsd, sellUsd, makers: r[`${k}_makers`] as number,
      };
    };
    out.set(r.token as string, { '5m': w('5m'), '1h': w('1h'), '6h': w('6h'), '24h': w('24h'), asOf });
  }
  const empty: Window = { priceChangePct: null, volumeUsd: 0, buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, makers: 0 };
  for (const t of tokens) if (!out.has(t)) out.set(t, { '5m': empty, '1h': empty, '6h': empty, '24h': empty, asOf });
  return out;
}

/** Latest trades in the realtime Trade shape (newest first). */
export async function recentTrades(sql: Sql, token: string, limit = 200) {
  const rows = await sql<
    { tx: string; log_index: number; time: Date; trader: string; side: 'buy' | 'sell'; token_amount: string; quote: string;
      quote_amount: string; pool: string; price_usd: number | null; usd: number | null }[]
  >`select tx, log_index, time, trader, side, token_amount::text, quote, quote_amount::text, pool,
      price_usd::float8 as price_usd, usd::float8 as usd
    from swaps where token = ${token} order by block desc, log_index desc limit ${limit}`;
  return rows.map((r) => ({
    tx: r.tx, logIndex: r.log_index, time: Math.floor(r.time.getTime() / 1000), trader: r.trader, side: r.side,
    tokenAmount: r.token_amount, quoteAmount: r.quote_amount, quote: r.quote, pool: r.pool,
    priceUsd: r.price_usd, usd: r.usd, tags: [] as string[],
  }));
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  trades: number;
}

/** Sub-minute candles (1s/15s/30s) computed from trades; trades are kept, so 24h of them is available. */
export async function subMinuteCandles(sql: Sql, token: string, seconds: number, minutes: number): Promise<Candle[]> {
  return sql<Candle[]>`
    select extract(epoch from b)::int as time,
      (array_agg(price_usd order by block, log_index))[1]::float8 as open, max(price_usd)::float8 as high,
      min(price_usd)::float8 as low, (array_agg(price_usd order by block desc, log_index desc))[1]::float8 as close,
      coalesce(sum(usd), 0)::float8 as volume, count(*)::int as trades
    from (select date_bin(${`${seconds} seconds`}::interval, time, timestamptz '2020-01-01') as b, * from swaps
          where token = ${token} and time > now() - ${Math.min(minutes, 24 * 60)} * interval '1 minute' and price_usd is not null) s
    group by b order by b`;
}

/** OHLCV from the stored 1m candles, aggregated to `interval`. */
export async function minuteCandles(sql: Sql, token: string, interval: string, hours: number): Promise<Candle[]> {
  return sql<Candle[]>`
    select extract(epoch from b)::int as time,
      (array_agg(open order by bucket))[1]::float8 as open, max(high)::float8 as high, min(low)::float8 as low,
      (array_agg(close order by bucket desc))[1]::float8 as close, sum(volume_usd)::float8 as volume, sum(trades)::int as trades
    from (select date_bin(${interval}::interval, bucket, timestamptz '2020-01-01') as b, * from candles
          where token = ${token} and interval = '1m' and bucket > now() - ${hours} * interval '1 hour') c
    group by b order by b`;
}

/** Everything a token page needs at once (the realtime `token:` snapshot, docs/realtime.md). */
export async function tokenSnapshot(sql: Sql, rpcUrl: string, token: string) {
  const [card] = await tokenSummaries(sql, { addresses: [token] });
  if (!card) return null;
  const [stats, pools, trades, c1s, c1m] = await Promise.all([
    tokenStats(sql, [token]).then((m) => m.get(token)!),
    tokenPools(sql, rpcUrl, token),
    recentTrades(sql, token, 200),
    subMinuteCandles(sql, token, 1, 30),
    minuteCandles(sql, token, '1 minute', 24),
  ]);
  return { card, stats, pools: pools ?? [], trades, candles: { '1s': c1s, '1m': c1m } };
}

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
      (s.data->'dev'->>'serialLauncher')::bool as serial_launcher, coalesce((s.data->>'spam')::bool, false) as spam,
      -- Quote asset as a symbol (ETH, WETH, USDG, stock tokens, other coins we track).
      case t.quote when '0x0000000000000000000000000000000000000000' then 'ETH' when '0x0bd7d308f8e1639fab988df18a8011f41eacad73' then 'WETH'
        when '0x5fc5360d0400a0fd4f2af552add042d716f1d168' then 'USDG' when '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea' then 'SPCX'
        when '0x5e81213613b6b86eab4c6c50d718d34359459786' then 'TTWO' when '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec' then 'NVDA'
        else (select q.symbol from tokens q where q.address = t.quote) end as quote_symbol,
      (select count(*)::int from swaps x where x.token = t.address and x.time > now() - interval '24 hours') as trades_24h,
      coalesce(substring(t.twitter from '(?:x|twitter)\.com/([A-Za-z0-9_]{1,30})(?:[/?#]|$)'), null) as twitter_handle,
      -- Tax is measured from real trades (signals); null until a token has 2 buys / 2 sells. Fees: not tracked yet.
      coalesce((s.data->>'buyTaxBps')::int, t.tax_bps) as buy_tax_bps, coalesce((s.data->>'sellTaxBps')::int, t.tax_bps) as sell_tax_bps,
      coalesce((s.data->>'noSells')::bool, false) as no_sells, coalesce((s.data->'dev'->>'farm')::bool, false) as farm,
      null::float8 as fees_paid_usd
    from tokens t left join signals s on s.token = t.address
    where t.address = any(${where.addresses ?? []})`;
}

/** Launchpads whose tokens trade on a bonding curve before graduating. */
export const CURVE_LAUNCHPADS = ['pons', 'liftfun'];
/**
 * Bonding progress at which a curve token moves from New to Almost bonded. GMGN's Robinhood column
 * (2026-11-12) started at ~23% once progress was read from real curve reserves (AME 72%, PIZZA 59%,
 * TARMAC 32%, AGENTIX 29%, CHEEK 26%, FATHER 23%).
 */
export const ALMOST_BONDED = 0.2;

export type Column = 'new' | 'almost' | 'migrated';
export const COLUMNS: Column[] = ['new', 'almost', 'migrated'];

/**
 * Which trenches column a card belongs to (same rules as the list query), or null when the default
 * trenches hide it (plain-pool tokens and spam are opt-in).
 */
export function columnOf(card: {
  status?: unknown; launchpad?: unknown; bonding_progress?: unknown; spam?: unknown; market_cap_usd?: unknown; holders?: unknown; volume_24h_usd?: unknown;
}): Column | null {
  if (card.spam === true) return null;
  // Launched straight onto a DEX pool (no curve): like GMGN, that's "migrated", unless it's dust.
  if (card.launchpad === 'uniswap-v4') return isDust(card) ? null : 'migrated';
  if (card.status === 'migrated') return isDust(card) ? null : 'migrated';
  const almost = CURVE_LAUNCHPADS.includes(String(card.launchpad)) && Number(card.bonding_progress ?? 0) >= ALMOST_BONDED;
  return almost ? 'almost' : 'new';
}

/** Migrated tokens hidden by default (GMGN-like): under $1K market cap, or no activity at all. */
export const DUST = { minMcapUsd: 1_000, minHolders: 10, minVolume24hUsd: 1_000 };
export function isDust(card: { market_cap_usd?: unknown; holders?: unknown; volume_24h_usd?: unknown }): boolean {
  const mcap = Number(card.market_cap_usd ?? 0);
  return mcap < DUST.minMcapUsd || (Number(card.holders ?? 0) < DUST.minHolders && Number(card.volume_24h_usd ?? 0) < DUST.minVolume24hUsd);
}
/** Almost bonded hides curves with no trade in this long (abandoned near the top). */
const ALMOST_STALE = '24 hours';

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
  /** New/Almost list launchpad tokens; plain-pool launches only appear there when opted in. */
  showPlain: boolean;
  /** Migrated: include dust (under $1K mcap, or no holders and no volume). */
  showDust?: boolean;
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
  // Migrated: graduated curve tokens plus tokens launched straight onto a DEX pool (GMGN shows both).
  const notDust = sql`(coalesce(t.market_cap_usd, 0) >= ${DUST.minMcapUsd}
    and (t.holders >= ${DUST.minHolders} or coalesce(t.volume_24h_usd, 0) >= ${DUST.minVolume24hUsd}))`;
  const columnWhere =
    q.column === 'migrated'
      ? sql`(t.status = 'migrated' or t.launchpad = 'uniswap-v4') and (${q.showDust ?? false} or ${notDust})`
      : q.column === 'almost'
        ? sql`t.status <> 'migrated' and ${almost} and t.price_at > now() - ${ALMOST_STALE}::interval`
        : sql`t.status <> 'migrated' and not ${almost}`;
  const order =
    q.column === 'migrated'
      ? sql`coalesce(t.migrated_at, t.created_at) desc`
      : q.column === 'almost'
        ? sql`t.bonding_progress desc nulls last, t.created_at desc`
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
      and (${q.showPlain} or ${q.column === 'migrated'} or t.launchpad <> 'uniswap-v4')
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
    const refresh = (async () => {
      const bal = await new Rpc(rpcUrl).balances(stale.flatMap((p) => [{ token, holder: p.id }, { token: p.quote, holder: p.id }]));
      const now = new Date();
      const updates: { id: string; usd: number }[] = [];
      for (const [i, p] of stale.entries()) {
        const tb = bal[i * 2];
        const qb = bal[i * 2 + 1];
        const q = quoteInfo(p.quote);
        if (tb == null || qb == null || q.usd == null) continue;
        const usd = (Number(tb) / 10 ** t.decimals) * Number(t.price_usd) + (Number(qb) / 10 ** q.decimals) * q.usd;
        p.liquidity_usd = String(usd);
        p.liquidity_at = now;
        updates.push({ id: p.id, usd });
      }
      for (const u of updates) await sql`update pools set liquidity_usd = ${u.usd}, liquidity_at = ${now} where id = ${u.id}`;
    })().catch((err) => console.error('pool tvl refresh failed', token, err));
    // Never hold a page on the RPC: answer with the last measured values after 1.5s; the refresh finishes behind.
    await Promise.race([refresh, new Promise((r) => setTimeout(r, 1_500))]);
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

/**
 * 5m/1h/6h/24h windows for several tokens in one query (index: swaps(token, time)). Tokens with no
 * trades in 24h still get their price change (0%) when they traded before.
 */
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
      , ((array_agg(s.price_usd order by s.block, s.log_index) filter (where s.time > now() - ${iv}::interval and s.price_usd is not null))[1])::float8 as ${sql(`${k}_first`)}
      , (select p.price_usd from swaps p where p.token = s.token and p.time <= now() - ${iv}::interval and p.price_usd is not null
           and p.time > now() - ${iv}::interval - interval '7 days'
         order by p.time desc limit 1)::float8 as ${sql(`${k}_prev`)}`,
  );
  const rows = await sql<Record<string, number | string | null>[]>`
    select s.token ${parts.reduce((a, p) => sql`${a} ${p}`, sql``)},
      (select price_usd from tokens t where t.address = s.token)::float8 as price
    from swaps s where s.token = any(${tokens}) and s.time > now() - interval '24 hours'
    group by s.token`;
  const asOf = Math.floor(Date.now() / 1000);
  for (const r of rows) {
    const w = (k: keyof typeof WINDOWS): Window => {
      // Like GMGN: against the close at the window's start (the last price before it); the first trade in
      // the window only for tokens younger than the window. A quiet window then reads 0%, not null.
      const open = (r[`${k}_prev`] as number | null) ?? (r[`${k}_first`] as number | null);
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
  const missing = tokens.filter((t) => !out.has(t));
  const priced = new Set(
    missing.length ? (await sql<{ address: string }[]>`select address from tokens where address = any(${missing}) and price_usd is not null`).map((r) => r.address) : [],
  );
  for (const t of missing) {
    // No trades in 24h: flat in every window if it ever traded, else unknown.
    const empty: Window = { priceChangePct: priced.has(t) ? 0 : null, volumeUsd: 0, buys: 0, sells: 0, buyUsd: 0, sellUsd: 0, makers: 0 };
    out.set(t, { '5m': empty, '1h': empty, '6h': empty, '24h': empty, asOf });
  }
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

/** Token page header (GET /tokens/:a): summary + supply/decimals + full signals + dev record + 24h trade count. */
export async function tokenDetail(sql: Sql, token: string) {
  const [summary] = await tokenSummaries(sql, { addresses: [token] });
  if (!summary) return null;
  const [extra] = await sql`
    select t.deployer, t.total_supply::text as total_supply, t.decimals, t.main_pool, t.created_block::text as created_block,
      t.launch_indexed, t.description, s.data as signals, s.updated_at as signals_updated_at
    from tokens t left join signals s on s.token = t.address where t.address = ${token}`;
  const [dev] = await sql`select * from deployer_stats where deployer = ${extra!.deployer}`;
  const [{ count: trades24h } = { count: 0 }] = await sql<{ count: number }[]>`
    select count(*)::int as count from swaps where token = ${token} and time > now() - interval '24 hours'`;
  return { ...summary, ...extra, dev: dev ?? null, trades_24h: trades24h };
}

/**
 * Recompute wallet_pnl from positions (+ current prices) and realized PnL per window from swaps.
 * Unrealized counts held tokens at the current price minus their average cost.
 */
export async function refreshWalletPnl(sql: Sql) {
  return sql`
    insert into wallet_pnl (wallet, realized_usd, unrealized_usd, realized_24h_usd, realized_7d_usd, realized_30d_usd,
      volume_usd, trades, tokens_traded, win_rate, best_trade_usd, last_trade_at, updated_at)
    select p.wallet,
      sum(p.realized_usd),
      sum(case when t.price_usd is not null and p.held_tokens > 0
               then p.held_tokens / power(10, t.decimals) * t.price_usd - p.cost_basis_usd else 0 end),
      coalesce(max(w.r24), 0), coalesce(max(w.r7), 0), coalesce(max(w.r30), 0),
      sum(p.bought_usd + p.sold_usd), sum(p.buys + p.sells)::int, count(*)::int,
      (count(*) filter (where p.held_tokens = 0 and p.sells > 0 and p.realized_usd > 0))::numeric
        / nullif(count(*) filter (where p.held_tokens = 0 and p.sells > 0), 0),
      max(w.best), max(p.last_trade_at), now()
    from positions p
    join tokens t on t.address = p.token
    left join (
      select trader, sum(realized_usd) filter (where time > now() - interval '24 hours') r24,
        sum(realized_usd) filter (where time > now() - interval '7 days') r7, sum(realized_usd) r30, max(realized_usd) best
      from swaps where realized_usd is not null and time > now() - interval '30 days' group by trader
    ) w on w.trader = p.wallet
    group by p.wallet
    on conflict (wallet) do update set realized_usd = excluded.realized_usd, unrealized_usd = excluded.unrealized_usd,
      realized_24h_usd = excluded.realized_24h_usd, realized_7d_usd = excluded.realized_7d_usd, realized_30d_usd = excluded.realized_30d_usd,
      volume_usd = excluded.volume_usd, trades = excluded.trades, tokens_traded = excluded.tokens_traded, win_rate = excluded.win_rate,
      best_trade_usd = excluded.best_trade_usd, last_trade_at = excluded.last_trade_at, updated_at = excluded.updated_at`;
}

/** A wallet's PnL summary and its positions (top 100 by total PnL magnitude), unrealized at current prices. */
export async function walletPnl(sql: Sql, wallet: string) {
  const [summary] = await sql`
    select wallet, realized_usd::float8, unrealized_usd::float8, realized_24h_usd::float8, realized_7d_usd::float8, realized_30d_usd::float8,
      volume_usd::float8, trades, tokens_traded, win_rate::float8, best_trade_usd::float8, last_trade_at, updated_at
    from wallet_pnl where wallet = ${wallet}`;
  const positions = await sql`
    select p.token, t.symbol, t.name, t.image_url, t.price_usd::float8 as price_usd,
      p.bought_tokens::text, p.bought_usd::float8, p.sold_tokens::text, p.sold_usd::float8, p.buys, p.sells,
      p.held_tokens::text, p.cost_basis_usd::float8, p.realized_usd::float8,
      case when t.price_usd is not null and p.held_tokens > 0
           then (p.held_tokens / power(10, t.decimals) * t.price_usd - p.cost_basis_usd)::float8 else 0 end as unrealized_usd,
      (p.unbacked_sold_tokens > 0) as unbacked, p.first_trade_at, p.last_trade_at
    from positions p join tokens t on t.address = p.token
    where p.wallet = ${wallet}
    order by abs(p.realized_usd + case when t.price_usd is not null and p.held_tokens > 0
                 then p.held_tokens / power(10, t.decimals) * t.price_usd - p.cost_basis_usd else 0 end) desc
    limit 100`;
  return { summary: summary ?? null, positions };
}

/** Everything a token page needs at once (the realtime `token:` snapshot, docs/realtime.md). */
export async function tokenSnapshot(sql: Sql, rpcUrl: string, token: string) {
  const card = await tokenDetail(sql, token);
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

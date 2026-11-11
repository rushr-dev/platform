import { Hono } from 'hono';
import postgres, { type Sql } from 'postgres';
import { tagHolders } from '@rushr/core';
import { dbUrl, type Env } from './env';
import { loadSnapshot } from './signals';

type Ctx = { Bindings: Env; Variables: { sql: Sql } };

export const api = new Hono<Ctx>();

// Short-lived connections per request (Neon's pooler in production).
api.use('*', async (c, next) => {
  const sql = postgres(dbUrl(c.env), { max: 2, fetch_types: false, prepare: false });
  c.set('sql', sql);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(sql.end({ timeout: 5 }));
  }
});

const cache = (seconds: number) => ({ 'cache-control': `public, max-age=${seconds}, s-maxage=${seconds}` });
const addr = (s: string | undefined) => (s ?? '').toLowerCase();

/** Fields every token card needs (trenches columns, search, live updates). */
export async function tokenSummaries(sql: Sql, where: { addresses?: string[] } = {}) {
  return sql`
    select t.address, t.symbol, t.name, t.image_url, t.website, t.twitter, t.telegram, t.launchpad, t.status, t.quote, t.created_at, t.migrated_at,
      t.price_usd::float8 as price_usd, t.market_cap_usd::float8 as market_cap_usd,
      t.ath_market_cap_usd::float8 as ath_market_cap_usd, t.volume_24h_usd::float8 as volume_24h_usd,
      t.holders, t.bonding_progress::float8 as bonding_progress,
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
const CURVE_LAUNCHPADS = ['pons', 'liftfun'];
/** Bonding progress at which a curve token moves from New to Almost bonded. */
const ALMOST_BONDED = 0.5;

/** Trenches columns. new / almost (bonding) / migrated, with GMGN-style filters. */
api.get('/tokens', async (c) => {
  const sql = c.var.sql;
  const column = c.req.query('column') ?? 'new';
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 100);
  const minMcap = Number(c.req.query('minMcap') ?? 0);
  const maxMcap = Number(c.req.query('maxMcap') ?? 1e15);
  const maxAgeMin = Number(c.req.query('maxAgeMin') ?? 7 * 24 * 60);
  const minHolders = Number(c.req.query('minHolders') ?? 0);
  const launchpad = c.req.query('launchpad') ?? null;
  const hideHighRisk = c.req.query('hideHighRisk') === '1';
  const showSpam = c.req.query('showSpam') === '1';
  // Like GMGN, the trenches list launchpad tokens; plain pools (where nearly all clones live) are opt-in.
  const showPlain = c.req.query('plain') === '1';

  // Almost bonded = launchpad tokens still on their bonding curve and at least halfway there,
  // like GMGN. Plain-pool tokens have no curve, so they never land here (whatever their market cap).
  const almost = sql`(t.launchpad = any(${CURVE_LAUNCHPADS}) and coalesce(t.bonding_progress, 0) >= ${ALMOST_BONDED})`;
  const columnWhere =
    column === 'migrated'
      ? sql`t.status = 'migrated'`
      : column === 'almost'
        ? sql`t.status <> 'migrated' and ${almost}`
        : sql`t.status <> 'migrated' and not ${almost}`;
  const order =
    column === 'migrated'
      ? sql`coalesce(t.migrated_at, t.created_at) desc`
      : column === 'almost'
        ? sql`t.bonding_progress desc nulls last, t.market_cap_usd desc nulls last`
        : sql`t.created_at desc`;

  const rows = await sql<{ address: string }[]>`
    select t.address from tokens t left join signals s on s.token = t.address
    where ${columnWhere}
      and coalesce(t.market_cap_usd, 0) between ${minMcap} and ${maxMcap}
      and t.created_at > now() - ${maxAgeMin} * interval '1 minute'
      and t.holders >= ${minHolders}
      and (${launchpad}::text is null or t.launchpad = ${launchpad})
      and (${!hideHighRisk} or coalesce(s.risk_level, 'unknown') <> 'high')
      and (${showSpam} or not coalesce((s.data->>'spam')::bool, false))
      and (${showPlain} or t.launchpad <> 'uniswap-v4')
    order by ${order}
    limit ${limit}`;
  const summaries = await tokenSummaries(sql, { addresses: rows.map((r) => r.address) });
  const byAddr = new Map(summaries.map((s) => [s.address, s]));
  return c.json({ column, tokens: rows.map((r) => byAddr.get(r.address)) }, 200, cache(2));
});

/** Token page header: summary + full signals + dev record. */
api.get('/tokens/:address', async (c) => {
  const sql = c.var.sql;
  const token = addr(c.req.param('address'));
  const [summary] = await tokenSummaries(sql, { addresses: [token] });
  if (!summary) return c.json({ error: 'not found' }, 404);
  const [extra] = await sql`
    select t.deployer, t.total_supply, t.decimals, t.main_pool, t.created_block, t.launch_indexed, t.description,
      s.data as signals, s.updated_at as signals_updated_at
    from tokens t left join signals s on s.token = t.address where t.address = ${token}`;
  const [dev] = await sql`select * from deployer_stats where deployer = ${extra!.deployer}`;
  const [{ count: trades24h } = { count: 0 }] = await sql<{ count: number }[]>`
    select count(*)::int as count from swaps where token = ${token} and time > now() - interval '24 hours'`;
  return c.json({ ...summary, ...extra, dev: dev ?? null, trades_24h: trades24h }, 200, cache(2));
});

api.get('/tokens/:address/signals', async (c) => {
  const [row] = await c.var.sql`select data, risk_level, verdict, updated_at from signals where token = ${addr(c.req.param('address'))}`;
  return row ? c.json(row, 200, cache(5)) : c.json({ error: 'not found' }, 404);
});

api.get('/tokens/:address/trades', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') ?? 100), 500);
  const rows = await c.var.sql`
    select tx, log_index, time, trader, side, token_amount, quote, quote_amount,
      price_usd::float8 as price_usd, usd::float8 as usd
    from swaps where token = ${addr(c.req.param('address'))}
    order by block desc, log_index desc limit ${limit}`;
  return c.json({ trades: rows }, 200, cache(1));
});

/** Holders with tags (dev, sniper, bundler, insider, fresh, airdrop). */
api.get('/tokens/:address/holders', async (c) => {
  const sql = c.var.sql;
  const token = addr(c.req.param('address'));
  const loaded = await loadSnapshot(sql, token, null);
  if (!loaded) return c.json({ error: 'not found' }, 404);
  const { snapshot } = loaded;
  const tags = tagHolders(snapshot);
  const supply = Number(snapshot.totalSupply);
  const holders = snapshot.holders.map((h) => ({
    wallet: h.wallet,
    amount: h.amount.toString(),
    pct: supply ? (Number(h.amount) / supply) * 100 : 0,
    tags: tags[h.wallet] ?? [],
    funder: snapshot.wallets[h.wallet]?.firstFunder ?? null,
  }));
  return c.json({ holders, total: snapshot.holderCount }, 200, cache(5));
});

/** OHLCV. 1m is stored; 5m/15m/1h/4h are aggregated here. */
api.get('/tokens/:address/candles', async (c) => {
  const intervals: Record<string, string> = { '1m': '1 minute', '5m': '5 minutes', '15m': '15 minutes', '1h': '1 hour', '4h': '4 hours' };
  const interval = intervals[c.req.query('interval') ?? '1m'] ?? '1 minute';
  const hours = Math.min(Number(c.req.query('hours') ?? 24), 24 * 7);
  const rows = await c.var.sql`
    select extract(epoch from b)::int as time,
      (array_agg(open order by bucket))[1]::float8 as open, max(high)::float8 as high, min(low)::float8 as low,
      (array_agg(close order by bucket desc))[1]::float8 as close, sum(volume_usd)::float8 as volume, sum(trades)::int as trades
    from (select date_bin(${interval}::interval, bucket, timestamptz '2020-01-01') as b, * from candles
          where token = ${addr(c.req.param('address'))} and interval = '1m' and bucket > now() - ${hours} * interval '1 hour') c
    group by b order by b`;
  return c.json({ candles: rows }, 200, cache(2));
});

/**
 * Bubble map: top holders as nodes, linked when they share a funder, one funded the other,
 * or they sent the token to each other.
 */
api.get('/tokens/:address/bubblemap', async (c) => {
  const sql = c.var.sql;
  const token = addr(c.req.param('address'));
  const loaded = await loadSnapshot(sql, token, null);
  if (!loaded) return c.json({ error: 'not found' }, 404);
  const { snapshot } = loaded;
  const tags = tagHolders(snapshot);
  const supply = Number(snapshot.totalSupply);
  const nodes = snapshot.holders.slice(0, 60).map((h) => ({
    wallet: h.wallet,
    pct: supply ? (Number(h.amount) / supply) * 100 : 0,
    tags: tags[h.wallet] ?? [],
    funder: snapshot.wallets[h.wallet]?.firstFunder ?? null,
  }));
  const ids = new Set(nodes.map((n) => n.wallet));
  const edges: { a: string; b: string; kind: 'shared-funder' | 'funded' | 'transfer' }[] = [];
  const byFunder = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.funder) continue;
    if (ids.has(n.funder)) edges.push({ a: n.funder, b: n.wallet, kind: 'funded' });
    const group = byFunder.get(n.funder) ?? [];
    group.push(n.wallet);
    byFunder.set(n.funder, group);
  }
  for (const group of byFunder.values()) for (let i = 1; i < group.length; i++) edges.push({ a: group[0]!, b: group[i]!, kind: 'shared-funder' });
  const wallets = [...ids];
  const moves = await sql<{ from: string; to: string }[]>`
    select distinct "from", "to" from transfers
    where token = ${token} and "from" = any(${wallets}) and "to" = any(${wallets}) and "from" <> "to"`;
  for (const m of moves) edges.push({ a: m.from, b: m.to, kind: 'transfer' });
  const clusters = [...byFunder.entries()]
    .filter(([, w]) => w.length > 1)
    .map(([funder, w]) => ({ funder, wallets: w, pct: nodes.filter((n) => w.includes(n.wallet)).reduce((t, n) => t + n.pct, 0) }))
    .sort((a, b) => b.pct - a.pct);
  return c.json({ nodes, edges, clusters }, 200, cache(10));
});

/** Dev page: stats plus every token from the deployer. */
api.get('/dev/:address', async (c) => {
  const sql = c.var.sql;
  const dev = addr(c.req.param('address'));
  const [stats] = await sql`select * from deployer_stats where deployer = ${dev}`;
  const tokens = await sql<{ address: string }[]>`select address from tokens where deployer = ${dev} order by created_at desc limit 100`;
  return c.json({ deployer: dev, stats: stats ?? null, tokens: await tokenSummaries(sql, { addresses: tokens.map((t) => t.address) }) }, 200, cache(10));
});

/** Search by contract, symbol or name. */
api.get('/search', async (c) => {
  const sql = c.var.sql;
  const q = (c.req.query('q') ?? '').trim();
  if (q.length < 2) return c.json({ tokens: [] });
  const rows = await sql<{ address: string }[]>`
    select address from tokens
    where address = ${q.toLowerCase()} or symbol ilike ${q + '%'} or name ilike ${'%' + q + '%'}
    order by (address = ${q.toLowerCase()}) desc, market_cap_usd desc nulls last limit 20`;
  return c.json({ tokens: await tokenSummaries(sql, { addresses: rows.map((r) => r.address) }) }, 200, cache(5));
});

/** Headline numbers for the landing page. */
api.get('/stats', async (c) => {
  const [row] = await c.var.sql`
    select (select count(*)::int from tokens) as tokens_tracked,
      (select count(*)::int from tokens where created_at > now() - interval '24 hours') as launches_24h,
      (select count(*)::int from signals) as safety_checks,
      (select count(*)::int from signals where risk_level = 'high') as flagged_high_risk,
      (select count(*)::int from swaps where time > now() - interval '24 hours') as trades_24h`;
  return c.json(row, 200, cache(30));
});


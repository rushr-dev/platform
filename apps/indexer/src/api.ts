import { Hono } from 'hono';
import postgres, { type Sql } from 'postgres';
import { tagHolders } from '@rushr/core';
import { dbUrl, type Env } from './env';
import { hydrator } from './hydrator';
import {
  POOL_TVL_TTL_S, minuteCandles, subMinuteCandles, tokenPools, tokenSnapshot, tokenStats, tokenSummaries, trenchesList,
} from './data';

export { tokenSummaries } from './data';
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

/**
 * A token we have nothing on: ask its hydrator to fetch it from chain (coalesced per token, rate
 * limited) and answer 202 so the page can show "fetching from chain" and follow the socket.
 */
async function hydrating(c: { env: Env; json: (b: unknown, s: 202 | 404) => Response }, token: string) {
  if (!/^0x[0-9a-f]{40}$/.test(token)) return c.json({ error: 'not found' }, 404);
  const { state } = await hydrator(c.env, token).hydrate(token);
  if (state === 'not_token') return c.json({ error: 'not found' }, 404);
  return c.json({ address: token, state, source: 'chain' }, 202);
}

/** Trenches columns. new / almost (bonding) / migrated, with GMGN-style filters. */
api.get('/tokens', async (c) => {
  const q = (k: string) => c.req.query(k);
  const column = q('column') ?? 'new';
  const tokens = await trenchesList(c.var.sql, {
    column,
    limit: Math.min(Number(q('limit') ?? 50), 100),
    minMcap: Number(q('minMcap') ?? 0),
    maxMcap: Number(q('maxMcap') ?? 1e15),
    maxAgeMin: Number(q('maxAgeMin') ?? 7 * 24 * 60),
    minHolders: Number(q('minHolders') ?? 0),
    launchpad: q('launchpad') ?? null,
    hideHighRisk: q('hideHighRisk') === '1',
    showSpam: q('showSpam') === '1',
    showPlain: q('plain') === '1',
  });
  return c.json({ column, tokens }, 200, cache(2));
});

/** Token page header: summary + full signals + dev record. */
api.get('/tokens/:address', async (c) => {
  const sql = c.var.sql;
  const token = addr(c.req.param('address'));
  const [summary] = await tokenSummaries(sql, { addresses: [token] });
  if (!summary) return hydrating(c, token);
  const [extra] = await sql`
    select t.deployer, t.total_supply, t.decimals, t.main_pool, t.created_block, t.launch_indexed, t.description,
      s.data as signals, s.updated_at as signals_updated_at
    from tokens t left join signals s on s.token = t.address where t.address = ${token}`;
  const [dev] = await sql`select * from deployer_stats where deployer = ${extra!.deployer}`;
  const [{ count: trades24h } = { count: 0 }] = await sql<{ count: number }[]>`
    select count(*)::int as count from swaps where token = ${token} and time > now() - interval '24 hours'`;
  return c.json({ ...summary, ...extra, dev: dev ?? null, trades_24h: trades24h }, 200, cache(2));
});

/** Every pool of a token with its routing key, 24h volume and liquidity (see tokenPools). */
api.get('/tokens/:address/pools', async (c) => {
  const pools = await tokenPools(c.var.sql, c.env.RPC_URL, addr(c.req.param('address')));
  if (!pools) return c.json({ error: 'not found' }, 404);
  return c.json({ pools }, 200, cache(POOL_TVL_TTL_S));
});

/** 5m/1h/6h/24h windows: price change, volume, buys/sells, buy/sell USD, makers. */
api.get('/tokens/:address/stats', async (c) => {
  const token = addr(c.req.param('address'));
  const stats = await tokenStats(c.var.sql, [token]);
  return c.json(stats.get(token), 200, cache(2));
});

/** The realtime `token:` snapshot (docs/realtime.md), for server rendering. */
api.get('/tokens/:address/snapshot', async (c) => {
  const token = addr(c.req.param('address'));
  const snap = await tokenSnapshot(c.var.sql, c.env.RPC_URL, token);
  if (!snap) return hydrating(c, token);
  if (!snap.trades.length) c.executionCtx.waitUntil(hydrator(c.env, token).hydrate(token).catch(() => undefined));
  return c.json({ ...snap, state: 'live', source: 'index' }, 200, cache(2));
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

/** OHLCV. 1m is stored (5m/15m/1h/4h aggregated from it); 1s/15s/30s come from trades (last 24h). */
api.get('/tokens/:address/candles', async (c) => {
  const token = addr(c.req.param('address'));
  const iv = c.req.query('interval') ?? '1m';
  const hours = Math.min(Number(c.req.query('hours') ?? 24), 24 * 7);
  const sub: Record<string, number> = { '1s': 1, '15s': 15, '30s': 30 };
  if (sub[iv]) {
    // Default windows keep responses small: 1s → 1h, 15s/30s → 6h (max 24h).
    const minutes = Math.min(Number(c.req.query('minutes') ?? (iv === '1s' ? 60 : 360)), 24 * 60);
    return c.json({ candles: await subMinuteCandles(c.var.sql, token, sub[iv], minutes) }, 200, cache(1));
  }
  const intervals: Record<string, string> = { '1m': '1 minute', '5m': '5 minutes', '15m': '15 minutes', '1h': '1 hour', '4h': '4 hours' };
  return c.json({ candles: await minuteCandles(c.var.sql, token, intervals[iv] ?? '1 minute', hours) }, 200, cache(2));
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


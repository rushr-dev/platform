// Paid data (x402, see x402.ts): deeper reads than the free API, built only from Rushr's own index. Nothing here is
// advice: it's who holds a token, how they're linked and how they trade.
//
//   holderGraph    top 100 holders (the free bubble map shows 60), every shared-funder, funding and transfer link,
//                  funders two hops up, and clusters with their share of supply
//   holderQuality  the top 100 holders' realized PnL, win rate and entry in this token, and how much supply sits
//                  with profitable, fresh, sniper, bundler and insider wallets
//   tokenReport    one-call due diligence: token, risk verdict and signals, dev record, and both summaries above
import type { Sql } from 'postgres';
import { circulatingSupply, tagHolders } from '@rushr/core';
import { loadSnapshot } from './signals';
import { tokenDetail } from './data';

type Loaded = NonNullable<Awaited<ReturnType<typeof loadSnapshot>>>;

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const num = (v: unknown): number | null => (v == null ? null : Number(v));

/** Holders as nodes: share of circulating supply, tags and first funder. */
function nodesOf({ snapshot }: Loaded) {
  const tags = tagHolders(snapshot);
  const supply = Number(circulatingSupply(snapshot));
  return snapshot.holders.map((h, i) => ({
    rank: i + 1,
    wallet: h.wallet,
    amount: h.amount.toString(),
    pct: supply ? round((Number(h.amount) / supply) * 100) : 0,
    tags: (tags[h.wallet] ?? []) as string[],
    funder: snapshot.wallets[h.wallet]?.firstFunder ?? null,
  }));
}
type Node = ReturnType<typeof nodesOf>[number];

const sumPct = (nodes: Node[], keep: (n: Node) => boolean) => round(nodes.filter(keep).reduce((t, n) => t + n.pct, 0), 2);

async function graphOf(sql: Sql, token: string, nodes: Node[]) {
  const ids = new Set(nodes.map((n) => n.wallet));
  const edges: { a: string; b: string; kind: 'shared-funder' | 'funded' | 'transfer'; count?: number }[] = [];
  const byFunder = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.funder) continue;
    if (ids.has(n.funder)) edges.push({ a: n.funder, b: n.wallet, kind: 'funded' });
    byFunder.set(n.funder, [...(byFunder.get(n.funder) ?? []), n.wallet]);
  }
  // Every pair in a funder group (the free map links each to the first only).
  for (const group of byFunder.values()) {
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) edges.push({ a: group[i]!, b: group[j]!, kind: 'shared-funder' });
  }
  const wallets = [...ids];
  const moves = await sql<{ from: string; to: string; n: number }[]>`
    select "from", "to", count(*)::int as n from transfers
    where token = ${token} and "from" = any(${wallets}) and "to" = any(${wallets}) and "from" <> "to"
    group by 1, 2`;
  for (const m of moves) edges.push({ a: m.from, b: m.to, kind: 'transfer', count: m.n });

  // Funders two hops up: who funded each funder (exchanges and other busy wallets were already dropped).
  const funders = [...byFunder.keys()];
  const up = funders.length
    ? await sql<{ address: string; first_funder: string | null }[]>`select address, first_funder from wallets where address = any(${funders})`
    : [];
  const funderOf = new Map(up.map((r) => [r.address, r.first_funder]));
  const clusters = [...byFunder.entries()]
    .filter(([, w]) => w.length > 1)
    .map(([funder, w]) => ({
      funder,
      funderFundedBy: funderOf.get(funder) ?? null,
      wallets: w,
      pct: sumPct(nodes, (n) => w.includes(n.wallet)),
      tags: [...new Set(nodes.filter((n) => w.includes(n.wallet)).flatMap((n) => n.tags))],
    }))
    .sort((a, b) => b.pct - a.pct);
  return { edges, clusters, funders: up.map((r) => ({ funder: r.address, fundedBy: r.first_funder })) };
}

async function qualityOf(sql: Sql, token: string, nodes: Node[]) {
  const wallets = nodes.map((n) => n.wallet);
  const [pnl, entries] = await Promise.all([
    sql<{ wallet: string; realized_usd: string; realized_30d_usd: string; unrealized_usd: string; volume_usd: string; trades: number; tokens_traded: number; win_rate: string | null; last_trade_at: Date }[]>`
      select wallet, realized_usd, realized_30d_usd, unrealized_usd, volume_usd, trades, tokens_traded, win_rate, last_trade_at
      from wallet_pnl where wallet = any(${wallets})`,
    sql<{ trader: string; first_buy: Date | null; bought_usd: string | null; sold_usd: string | null; buys: number; sells: number }[]>`
      select trader, min(time) filter (where side = 'buy') as first_buy,
        sum(usd) filter (where side = 'buy') as bought_usd, sum(usd) filter (where side = 'sell') as sold_usd,
        count(*) filter (where side = 'buy')::int as buys, count(*) filter (where side = 'sell')::int as sells
      from swaps where token = ${token} and trader = any(${wallets}) group by trader`,
  ]);
  const p = new Map(pnl.map((r) => [r.wallet, r]));
  const e = new Map(entries.map((r) => [r.trader, r]));
  const holders = nodes.map((n) => {
    const w = p.get(n.wallet);
    const x = e.get(n.wallet);
    return {
      rank: n.rank,
      wallet: n.wallet,
      pct: n.pct,
      tags: n.tags,
      inThisToken: x
        ? { firstBuy: x.first_buy, boughtUsd: num(x.bought_usd), soldUsd: num(x.sold_usd), buys: x.buys, sells: x.sells }
        : null, // no swaps: got it by transfer, airdrop or before our index
      record: w
        ? {
            realizedUsd: num(w.realized_usd),
            realized30dUsd: num(w.realized_30d_usd),
            unrealizedUsd: num(w.unrealized_usd),
            volumeUsd: num(w.volume_usd),
            trades: w.trades,
            tokensTraded: w.tokens_traded,
            winRate: num(w.win_rate),
            lastTradeAt: w.last_trade_at,
          }
        : null, // no indexed trades
    };
  });
  const has = (t: string) => (n: Node) => n.tags.includes(t);
  const withRecord = holders.filter((h) => h.record);
  const weight = withRecord.reduce((t, h) => t + h.pct, 0);
  const summary = {
    holdersChecked: holders.length,
    withTradeRecord: withRecord.length,
    supplyPct: {
      profitable30d: sumPct(nodes, (n) => (p.get(n.wallet) ? Number(p.get(n.wallet)!.realized_30d_usd) > 0 : false)),
      losing30d: sumPct(nodes, (n) => (p.get(n.wallet) ? Number(p.get(n.wallet)!.realized_30d_usd) < 0 : false)),
      noTradeRecord: sumPct(nodes, (n) => !p.get(n.wallet)),
      fresh: sumPct(nodes, has('fresh')),
      sniper: sumPct(nodes, has('sniper')),
      bundler: sumPct(nodes, has('bundler')),
      insider: sumPct(nodes, has('insider')),
      dev: sumPct(nodes, has('dev')),
      airdrop: sumPct(nodes, has('airdrop')),
    },
    /** Win rate of the holders with a record, weighted by how much they hold. */
    weightedWinRate: weight
      ? round(withRecord.reduce((t, h) => t + (h.record!.winRate ?? 0) * h.pct, 0) / weight, 4)
      : null,
  };
  return { summary, holders };
}

const meta = (loaded: Loaded, nodes: Node[]) => ({
  holdersTotal: loaded.snapshot.holderCount,
  holdersMapped: nodes.length,
  top10Pct: sumPct(nodes.slice(0, 10), () => true),
  generatedAt: new Date().toISOString(),
  source: 'Rushr index of Robinhood Chain (chain 4663). Data, not advice.',
});

export async function holderGraph(sql: Sql, token: string) {
  const loaded = await loadSnapshot(sql, token, null);
  if (!loaded) return null;
  const nodes = nodesOf(loaded);
  return { token, symbol: loaded.snapshot.symbol, ...meta(loaded, nodes), nodes, ...(await graphOf(sql, token, nodes)) };
}

export async function holderQuality(sql: Sql, token: string) {
  const loaded = await loadSnapshot(sql, token, null);
  if (!loaded) return null;
  const nodes = nodesOf(loaded);
  return { token, symbol: loaded.snapshot.symbol, ...meta(loaded, nodes), ...(await qualityOf(sql, token, nodes)) };
}

export async function tokenReport(sql: Sql, token: string) {
  const [detail, loaded] = await Promise.all([tokenDetail(sql, token), loadSnapshot(sql, token, null)]);
  if (!detail || !loaded) return null;
  const nodes = nodesOf(loaded);
  const deployer = loaded.snapshot.deployer;
  const [[signals], [devStats], devTokens, graph, quality] = await Promise.all([
    sql<{ data: unknown; risk_level: string; verdict: string; updated_at: Date }[]>`
      select data, risk_level, verdict, updated_at from signals where token = ${token}`,
    sql`select launches, launches_7d, rugs, migrated, avg_seconds_to_dev_sell, best_peak_mcap_usd::float8 as best_peak_mcap_usd from deployer_stats where deployer = ${deployer}`,
    sql<{ address: string; symbol: string; status: string; created_at: Date; ath_market_cap_usd: number | null; market_cap_usd: number | null }[]>`
      select address, symbol, status, created_at, ath_market_cap_usd::float8 as ath_market_cap_usd, market_cap_usd::float8 as market_cap_usd
      from tokens where deployer = ${deployer} and address <> ${token} order by created_at desc limit 20`,
    graphOf(sql, token, nodes),
    qualityOf(sql, token, nodes),
  ]);
  return {
    token,
    symbol: loaded.snapshot.symbol,
    ...meta(loaded, nodes),
    market: detail,
    risk: signals ? { level: signals.risk_level, verdict: signals.verdict, signals: signals.data, updatedAt: signals.updated_at } : null,
    dev: { deployer, stats: devStats ?? null, otherTokens: devTokens },
    clusters: { count: graph.clusters.length, pct: round(graph.clusters.reduce((t, c) => t + c.pct, 0), 2), largest: graph.clusters.slice(0, 5) },
    holderQuality: quality.summary,
    top10: quality.holders.slice(0, 10),
  };
}

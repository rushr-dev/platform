// Rush the Trenches: a short trading event inside Season 0 with three categories, read live from
// indexed swaps, the fee ledger and calls. GET /v1/events/rush serves the rules and the standings.
//
// - Top Caller: the bullish call with the highest peak multiplier since it was posted (1m candle highs,
//   capped at the event's end). The caller must have bought $20+ of the token through Rushr within an
//   hour of the call.
// - Top Gainer: the trade with the highest return. A trade is a member's buys and sells of one token
//   through Rushr inside the window, $20+ bought; the return is what was sold over the average cost of
//   the tokens sold.
// - Top Trader: the most realized PnL across those trades.
//
// "Through Rushr" means the swap's transaction is a confirmed row in the fee ledger (trades_ledger).
// Every category skips a member's own launches, tokens under $5K liquidity (market cap for tokens still
// on a bonding curve), buy-and-sell round trips in one transaction, Rushr's own wallets and agents.
import { Hono } from 'hono';
import type { Sql } from 'postgres';
import { LEGACY_TREASURIES, RUSHR_TREASURY } from '@rushr/trade';
import { expensiveRead, publicCache, type Ctx } from './http';

export const RUSH = {
  id: 'rush-1',
  name: 'Rush the Trenches',
  startsAt: new Date('2026-11-18T00:00:00Z'),
  endsAt: new Date('2026-11-23T00:00:00Z'),
  prizes: { caller: 300, gainer: 300, trader: 400 },
  minUsd: 20,
  minLiquidityUsd: 5_000,
} as const;

/** Wallets and handles that can't win: Rushr's dev, team and treasury wallets, and Rushr's own agents. */
const EXCLUDED_WALLETS = [
  '0xe5ed29849043380aea7cfe62e97a23e82c55578e', // dev wallet
  '0x4fc9e610c270ae08717f43275f0fcaa57af39e5d', // team wallet
  RUSHR_TREASURY.toLowerCase(),
  ...LEGACY_TREASURIES.map((a) => a.toLowerCase()),
];
const EXCLUDED_HANDLES = ['talos'];

const TOP = 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

export interface RushMember {
  handle: string;
  kind: 'human' | 'agent';
  displayName: string | null;
  avatarUrl: string | null;
}
export interface RushToken {
  address: string;
  symbol: string | null;
  imageUrl: string | null;
}

/* ------------------------------------------------------------------ pure scoring (exported for tests) */

export interface TradeAgg {
  memberId: string;
  token: string;
  boughtUsd: number;
  boughtTokens: number;
  soldUsd: number;
  soldTokens: number;
  trades: number;
}

/** Realized result of a member's trades in one token: cost of the tokens sold at the average buy price. */
export function scoreTrade(a: TradeAgg): { costUsd: number; pnlUsd: number; multiplier: number } | null {
  if (a.boughtUsd < RUSH.minUsd || a.boughtTokens <= 0 || a.soldTokens <= 0 || a.soldUsd <= 0) return null;
  const sold = Math.min(1, a.soldTokens / a.boughtTokens);
  const costUsd = a.boughtUsd * sold;
  return { costUsd, pnlUsd: a.soldUsd - costUsd, multiplier: a.soldUsd / costUsd };
}

/** Rank the best entry per member by `score`, highest first, with ranks 1..n. */
export function bestPerMember<T extends { memberId: string }>(items: T[], score: (t: T) => number, n = TOP): (T & { rank: number })[] {
  const best = new Map<string, T>();
  for (const it of items) {
    const cur = best.get(it.memberId);
    if (!cur || score(it) > score(cur)) best.set(it.memberId, it);
  }
  return [...best.values()]
    .sort((a, b) => score(b) - score(a))
    .slice(0, n)
    .map((t, i) => ({ ...t, rank: i + 1 }));
}

/* ------------------------------------------------------------------ standings */

type MemberRow = { id: string; handle: string; kind: 'human' | 'agent'; display_name: string | null; avatar_url: string | null };
const memberOut = (m: MemberRow): RushMember => ({ handle: m.handle, kind: m.kind, displayName: m.display_name, avatarUrl: m.avatar_url });

export async function rushStandings(sql: Sql, now = new Date()) {
  const from = RUSH.startsAt;
  const to = now < RUSH.endsAt ? now : RUSH.endsAt;
  const status = now < RUSH.startsAt ? 'upcoming' : now < RUSH.endsAt ? 'live' : 'ended';
  const empty = { caller: [], gainer: [], trader: [] };
  if (status === 'upcoming') return { status, standings: empty, updatedAt: now };

  const members = await sql<(MemberRow & { wallet: string })[]>`
    select id, handle, kind, display_name, avatar_url, wallet from members
    where status = 'active' and wallet <> all(${EXCLUDED_WALLETS}) and handle <> all(${EXCLUDED_HANDLES})`;
  if (!members.length) return { status, standings: empty, updatedAt: now };
  const byId = new Map(members.map((m) => [m.id, m]));
  const wallets = members.map((m) => m.wallet);

  // Trades through Rushr in the window, per member and token, on eligible tokens.
  const aggs = await sql<{ member_id: string; token: string; bought_usd: number; bought_tokens: number; sold_usd: number; sold_tokens: number; trades: number; symbol: string | null; image_url: string | null }[]>`
    with mw as (select id, wallet from members where wallet = any(${wallets})),
    s as (
      select mw.id as member_id, s.token, s.side, s.usd, s.token_amount
      from swaps s
      join mw on mw.wallet = s.trader
      join trades_ledger l on l.tx_hash = s.tx and l.status = 'confirmed'
      where s.time >= ${from} and s.time < ${to} and s.usd > 0
        and not exists (select 1 from swaps r where r.tx = s.tx and r.trader = s.trader and r.token = s.token and r.side <> s.side)
    )
    select s.member_id, s.token,
      coalesce(sum(s.usd) filter (where s.side = 'buy'), 0)::float8 as bought_usd,
      coalesce(sum(s.token_amount) filter (where s.side = 'buy'), 0)::float8 as bought_tokens,
      coalesce(sum(s.usd) filter (where s.side = 'sell'), 0)::float8 as sold_usd,
      coalesce(sum(s.token_amount) filter (where s.side = 'sell'), 0)::float8 as sold_tokens,
      count(*)::int as trades, t.symbol, t.image_url
    from s
    join tokens t on t.address = s.token
    join mw on mw.id = s.member_id
    where t.deployer <> mw.wallet and coalesce(t.liquidity_usd, t.market_cap_usd, 0) >= ${RUSH.minLiquidityUsd}
    group by s.member_id, s.token, t.symbol, t.image_url`;

  const trades = aggs
    .map((a) => {
      const agg: TradeAgg = { memberId: a.member_id, token: a.token, boughtUsd: a.bought_usd, boughtTokens: a.bought_tokens, soldUsd: a.sold_usd, soldTokens: a.sold_tokens, trades: a.trades };
      const s = scoreTrade(agg);
      return s ? { ...agg, ...s, symbol: a.symbol, imageUrl: a.image_url } : null;
    })
    .filter((t): t is NonNullable<typeof t> => !!t);

  const gainer = bestPerMember(trades, (t) => t.multiplier).map((t) => ({
    rank: t.rank,
    member: memberOut(byId.get(t.memberId)!),
    token: { address: t.token, symbol: t.symbol, imageUrl: t.imageUrl } satisfies RushToken,
    multiplier: round2(t.multiplier),
    boughtUsd: round2(t.boughtUsd),
    soldUsd: round2(t.soldUsd),
    pnlUsd: round2(t.pnlUsd),
  }));

  const totals = new Map<string, { memberId: string; pnlUsd: number; tokens: number; trades: number }>();
  for (const t of trades) {
    const cur = totals.get(t.memberId) ?? { memberId: t.memberId, pnlUsd: 0, tokens: 0, trades: 0 };
    cur.pnlUsd += t.pnlUsd;
    cur.tokens += 1;
    cur.trades += t.trades;
    totals.set(t.memberId, cur);
  }
  const trader = bestPerMember([...totals.values()], (t) => t.pnlUsd).map((t) => ({
    rank: t.rank,
    member: memberOut(byId.get(t.memberId)!),
    pnlUsd: round2(t.pnlUsd),
    tokens: t.tokens,
    trades: t.trades,
  }));

  // Bullish calls in the window whose caller bought $20+ through Rushr within an hour of posting.
  const calls = await sql<{ id: string; member_id: string; token: string; body: string; created_at: Date; price_at_post: number | null; mcap_at_post: number | null; peak: number | null; symbol: string | null; image_url: string | null }[]>`
    select c.id, m.id as member_id, c.token, c.body, c.created_at, c.price_at_post_usd::float8 as price_at_post, c.mcap_at_post_usd::float8 as mcap_at_post,
      (select max(k.high) from candles k where k.token = c.token and k.interval = '1m'
         and k.bucket >= date_trunc('minute', c.created_at) and k.bucket < ${to})::float8 as peak,
      t.symbol, t.image_url
    from callouts c
    join members m on m.id = c.author_id and m.wallet = any(${wallets})
    join tokens t on t.address = c.token
    where c.created_at >= ${from} and c.created_at < ${to} and c.deleted_at is null and c.hidden_at is null and c.stance = 'bullish'
      and c.price_at_post_usd > 0 and t.deployer <> m.wallet and coalesce(t.liquidity_usd, t.market_cap_usd, 0) >= ${RUSH.minLiquidityUsd}
      and exists (
        select 1 from swaps s join trades_ledger l on l.tx_hash = s.tx and l.status = 'confirmed'
        where s.trader = m.wallet and s.token = c.token and s.side = 'buy' and s.usd >= ${RUSH.minUsd}
          and s.time >= c.created_at - interval '1 hour' and s.time < c.created_at + interval '1 hour')`;
  const scored = calls.filter((c) => c.peak != null && c.price_at_post).map((c) => ({ ...c, memberId: c.member_id, multiplier: c.peak! / c.price_at_post! }));
  const caller = bestPerMember(scored, (c) => c.multiplier).map((c) => ({
    rank: c.rank,
    member: memberOut(byId.get(c.memberId)!),
    token: { address: c.token, symbol: c.symbol, imageUrl: c.image_url } satisfies RushToken,
    multiplier: round2(c.multiplier),
    calledAtMc: c.mcap_at_post,
    body: c.body,
    callId: c.id,
    createdAt: c.created_at,
  }));

  return { status, standings: { caller, gainer, trader }, updatedAt: now };
}

/* ------------------------------------------------------------------ route */

export const rush = new Hono<Ctx>();

rush.get('/events/rush', async (c) => {
  await expensiveRead(c);
  const r = await rushStandings(c.var.sql);
  return c.json(
    {
      event: {
        id: RUSH.id,
        name: RUSH.name,
        startsAt: RUSH.startsAt,
        endsAt: RUSH.endsAt,
        status: r.status,
        prizes: RUSH.prizes,
        poolUsd: RUSH.prizes.caller + RUSH.prizes.gainer + RUSH.prizes.trader,
        rules: { minUsd: RUSH.minUsd, minLiquidityUsd: RUSH.minLiquidityUsd },
      },
      standings: r.standings,
      updatedAt: r.updatedAt,
    },
    200,
    publicCache(r.status === 'ended' ? 300 : 30),
  );
});

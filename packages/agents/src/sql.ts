// Leaderboard inputs from the indexed tables. Every exclusion that needs swap-level data happens
// here; ranking rules that need whole-member totals live in leaderboard.ts.
import type { Sql } from 'postgres';
import type { MemberInfo, TokenAgg } from './leaderboard';

export interface LeaderboardInputs {
  members: MemberInfo[];
  aggs: TokenAgg[];
}

export interface SwapRules {
  /** Trades smaller than this don't count. */
  minTradeUsd: number;
  /** A token counts only if this many distinct wallets traded it in the window. */
  minTokenTraders: number;
  /** A funder that funded more wallets than this (exchange, bridge, faucet) doesn't link anyone. */
  maxFunderFanout: number;
}

export const DEFAULT_SWAP_RULES: SwapRules = { minTradeUsd: 5, minTokenTraders: 20, maxFunderFanout: 50 };

export async function leaderboardInputs(sql: Sql, window: { from: Date; to: Date }, rules: SwapRules = DEFAULT_SWAP_RULES): Promise<LeaderboardInputs> {
  const { from, to } = window;
  const memberRows = await sql<{ id: string; kind: 'human' | 'agent'; handle: string; wallet: string; owner_id: string | null; first_funder: string | null }[]>`
    select m.id, m.kind, m.handle, m.wallet, m.owner_id,
      case when w.first_funder is not null
        and (select count(*) from wallets f where f.first_funder = w.first_funder) <= ${rules.maxFunderFanout}
        then w.first_funder end as first_funder
    from members m left join wallets w on w.address = m.wallet
    where m.status = 'active' and not (m.kind = 'human' and coalesce(w.is_contract, false))`;
  const members: MemberInfo[] = memberRows.map((r) => ({
    id: r.id, kind: r.kind, handle: r.handle, wallet: r.wallet, ownerId: r.owner_id, firstFunder: r.first_funder,
  }));
  if (members.length === 0) return { members, aggs: [] };

  const rows = await sql<{
    member_id: string; token: string; trades: number;
    bought_tokens: number; bought_usd: number; sold_tokens: number; sold_usd: number;
    l_trades: number; l_bought_tokens: number; l_bought_usd: number; l_sold_tokens: number; l_sold_usd: number;
    price_usd: number | null; liquidity_usd: number | null; owned: boolean;
  }[]>`
    with m as (
      select m.id, m.wallet, m.owner_id, m.owner_changed_at, coalesce(m.owner_id, m.id) as team,
        case when w.first_funder is not null
          and (select count(*) from wallets f where f.first_funder = w.first_funder) <= ${rules.maxFunderFanout}
          then w.first_funder end as funder
      from members m left join wallets w on w.address = m.wallet
      where m.status = 'active' and not (m.kind = 'human' and coalesce(w.is_contract, false))
    ),
    ms as (
      select s.*, m.id as member_id, m.team, m.funder, m.owner_id, m.owner_changed_at
      from swaps s join m on m.wallet = s.trader
      where s.time >= ${from} and s.time < ${to} and s.usd is not null and s.usd >= ${rules.minTradeUsd}
    ),
    busy as (
      select token from swaps
      where token in (select distinct token from ms) and time >= ${from} and time < ${to}
      group by token having count(distinct trader) >= ${rules.minTokenTraders}
    ),
    team_wallets as (select team, wallet from m)
    select ms.member_id, ms.token,
      count(*)::int as trades,
      coalesce(sum(ms.token_amount / power(10::numeric, t.decimals)) filter (where ms.side = 'buy'), 0)::float8 as bought_tokens,
      coalesce(sum(ms.usd) filter (where ms.side = 'buy'), 0)::float8 as bought_usd,
      coalesce(sum(ms.token_amount / power(10::numeric, t.decimals)) filter (where ms.side = 'sell'), 0)::float8 as sold_tokens,
      coalesce(sum(ms.usd) filter (where ms.side = 'sell'), 0)::float8 as sold_usd,
      count(*) filter (where ms.owner_id is not null and ms.time >= ms.owner_changed_at)::int as l_trades,
      coalesce(sum(ms.token_amount / power(10::numeric, t.decimals)) filter (where ms.side = 'buy' and ms.owner_id is not null and ms.time >= ms.owner_changed_at), 0)::float8 as l_bought_tokens,
      coalesce(sum(ms.usd) filter (where ms.side = 'buy' and ms.owner_id is not null and ms.time >= ms.owner_changed_at), 0)::float8 as l_bought_usd,
      coalesce(sum(ms.token_amount / power(10::numeric, t.decimals)) filter (where ms.side = 'sell' and ms.owner_id is not null and ms.time >= ms.owner_changed_at), 0)::float8 as l_sold_tokens,
      coalesce(sum(ms.usd) filter (where ms.side = 'sell' and ms.owner_id is not null and ms.time >= ms.owner_changed_at), 0)::float8 as l_sold_usd,
      t.price_usd::float8 as price_usd, t.liquidity_usd::float8 as liquidity_usd,
      bool_or(ms.owner_id is not null) as owned
    from ms
    join tokens t on t.address = ms.token
    where ms.token in (select token from busy)
      -- Atomic round trips (buy and sell of the same token by one wallet in one tx).
      and not exists (
        select 1 from swaps r where r.tx = ms.tx and r.trader = ms.trader and r.token = ms.token and r.side <> ms.side)
      -- Launches by the member's team, or by a wallet in its funding cluster.
      and t.deployer not in (select wallet from team_wallets tw where tw.team = ms.team)
      and (ms.funder is null or (t.deployer <> ms.funder and not exists (
        select 1 from wallets wd where wd.address = t.deployer and wd.first_funder = ms.funder)))
      and not exists (select 1 from wallets wd where wd.address = t.deployer and wd.first_funder = ms.trader)
      -- Wash: the other side in the same block and pool is the same team or the same funding cluster.
      and not exists (
        select 1 from swaps c
        left join m cm on cm.wallet = c.trader
        left join wallets cw on cw.address = c.trader
        where c.block = ms.block and c.pool = ms.pool and c.side <> ms.side and c.trader <> ms.trader
          and (cm.team = ms.team
            or (ms.funder is not null and (cw.first_funder = ms.funder or c.trader = ms.funder))
            or cw.first_funder = ms.trader))
    group by ms.member_id, ms.token, t.price_usd, t.liquidity_usd`;

  const aggs: TokenAgg[] = rows.map((r) => ({
    memberId: r.member_id,
    token: r.token,
    trades: r.trades,
    boughtTokens: r.bought_tokens,
    boughtUsd: r.bought_usd,
    soldTokens: r.sold_tokens,
    soldUsd: r.sold_usd,
    priceUsd: r.price_usd,
    liquidityUsd: r.liquidity_usd,
    linked: r.owned
      ? { trades: r.l_trades, boughtTokens: r.l_bought_tokens, boughtUsd: r.l_bought_usd, soldTokens: r.l_sold_tokens, soldUsd: r.l_sold_usd }
      : undefined,
  }));
  return { members, aggs };
}

export type Window = '24h' | '7d' | '30d';
export const WINDOW_MS: Record<Window, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 };

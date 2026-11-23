import type { Sql } from 'postgres';
import { STOCK_DEPLOYERS, STOCK_NAME_SUFFIX } from '@rushr/core';

/**
 * Trending in the trenches: tokens by swap volume over the last hour, with their trades and the calls
 * posted on them in that hour. Stock tokens are left out (they have their own Stocks page), and so is
 * airdrop-farm spam.
 *
 * Summing an hour of swaps takes a few seconds on the full table, too slow per request: the cron
 * computes it every 2 minutes into indexer_state, and GET /tokens/trending serves that.
 */

export const TRENDING_KEY = 'trending:1h';
const TOP = 40;

/**
 * Pinned at the top of Trending under "Featured", whatever their volume, in this order. Edit to change.
 * Official contracts only (copycats share these tickers): checked against each project's own site, 2026-11-23.
 */
export const FEATURED_TOKENS: readonly string[] = [
  '0x39dbed3a2bd333467115de45665cc57f813c4571', // PONS
  '0x72be1277e198d0c476869253cb4e62807e14533c', // RAETO (raeto.cc)
  '0x20429af7ca3b0ce4d99edbaa0693f26c5df05195', // QHOOKS (qhooks.com)
  '0x6354a37799e96ed6ccaecffbe1c100fa7f30cec8', // ZENI, Tokyo Futuro
  '0xb33eb16782776b4d738c0fd643577cb0284db610', // HEY, HEY Research Lab (heyresearch.xyz)
];

export interface TrendRow {
  token: string;
  volume1h: number;
  trades1h: number;
  calls1h: number;
}

export interface TrendingState {
  at: string;
  items: TrendRow[];
}

/** Recompute the hour's top tokens and store them. Returns how many were stored. */
export async function refreshTrending(sql: Sql): Promise<number> {
  // Only tokens priced in the last hour can have swaps in it: that keeps the scan on swaps' (token, time) index.
  const rows = await sql<{ token: string; volume: number; trades: number; calls: number }[]>`
    with active as (
      select t.address from tokens t left join signals s on s.token = t.address
      where t.price_at > now() - interval '1 hour'
        and not (t.deployer = any(${STOCK_DEPLOYERS}) and right(coalesce(t.name, ''), ${STOCK_NAME_SUFFIX.length}) = ${STOCK_NAME_SUFFIX})
        and not coalesce((s.data->>'spam')::bool, false)
    ),
    vol as (
      select a.address as token, sum(w.usd)::float8 as volume, count(*)::int as trades
      from active a
      join lateral (select usd from swaps where token = a.address and time > now() - interval '1 hour' and usd is not null) w on true
      group by a.address
    )
    select v.token, v.volume, v.trades,
      (select count(*)::int from callouts c where c.token = v.token and c.created_at > now() - interval '1 hour' and c.deleted_at is null) as calls
    from vol v
    where v.volume > 0
    order by v.volume desc
    limit ${TOP}`;
  const state: TrendingState = {
    at: new Date().toISOString(),
    items: rows.map((r) => ({ token: r.token, volume1h: Math.round(r.volume), trades1h: r.trades, calls1h: r.calls })),
  };
  await sql`
    insert into indexer_state (key, value, updated_at) values (${TRENDING_KEY}, ${sql.json(state as never)}, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
  return state.items.length;
}

/** The stored list, featured tokens first (marked), each once. */
export async function readTrending(sql: Sql): Promise<{ at: string | null; rows: (TrendRow & { featured: boolean })[] }> {
  const [s] = await sql<{ value: TrendingState }[]>`select value from indexer_state where key = ${TRENDING_KEY}`;
  const items = s?.value.items ?? [];
  const byToken = new Map(items.map((r) => [r.token, r]));
  const featured = FEATURED_TOKENS.map((t) => ({ ...(byToken.get(t) ?? { token: t, volume1h: 0, trades1h: 0, calls1h: 0 }), featured: true }));
  const rest = items.filter((r) => !FEATURED_TOKENS.includes(r.token)).map((r) => ({ ...r, featured: false }));
  return { at: s?.value.at ?? null, rows: [...featured, ...rest] };
}

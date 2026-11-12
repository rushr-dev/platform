import type { Sql } from 'postgres';
import { Rpc } from './rpc';

/**
 * Wallet reads: holdings, positions and one position.
 *
 * What a wallet holds comes from `balances` (built from Transfer logs), not from `positions`. Positions
 * are built from swaps only, so tokens sent to another wallet (or received from one) never moved them:
 * on a sample of 300 open positions, 141 showed tokens the wallet no longer had. A position's cost basis
 * is scaled to the share of the bought tokens still held; tokens received without a buy count at zero cost.
 */

/** SQL pieces over aliases p (positions, may be null), b (balances), t (tokens). */
const HELD = 'greatest(coalesce(b.amount, 0), 0)';
const COST = `(case when coalesce(p.held_tokens, 0) > 0 then p.cost_basis_usd * least(1, ${HELD} / p.held_tokens) else 0 end)`;
const VALUE = `(case when t.price_usd is not null then ${HELD} / power(10, t.decimals) * t.price_usd end)`;
const UNREALIZED = `(case when t.price_usd is not null and ${HELD} > 0 then ${HELD} / power(10, t.decimals) * t.price_usd - ${COST} else 0 end)`;
export const WALLET_SQL = { HELD, COST, VALUE, UNREALIZED };

export const PAGE_MAX = 500;
export const page = (q: (k: string) => string | undefined, def = 100) => ({
  offset: Math.max(0, Number(q('offset') ?? 0) || 0),
  limit: Math.min(PAGE_MAX, Math.max(1, Number(q('limit') ?? def) || def)),
});

/** Price change over 24h like the token stats: against the last trade before the window, else the first in it. */
const CHANGE_24H = `
  (select case when o.open > 0 and t.price_usd is not null then ((t.price_usd - o.open) / o.open * 100)::float8 end
   from (select coalesce(
     (select x.price_usd from swaps x where x.token = t.address and x.price_usd is not null
        and x.time <= now() - interval '24 hours' and x.time > now() - interval '8 days' order by x.time desc limit 1),
     (select x.price_usd from swaps x where x.token = t.address and x.price_usd is not null
        and x.time > now() - interval '24 hours' order by x.time limit 1)) as open) o)`;

/** Tokens the wallet holds now (balance > 0), by $ value, paged (no fixed cap). */
export async function walletHoldings(sql: Sql, wallet: string, pg: { offset: number; limit: number }) {
  const rows = await sql.unsafe(
    `select t.address as token, t.symbol, t.name, t.image_url, t.decimals, t.launchpad, t.status,
       b.amount::text as amount, (b.amount / power(10, t.decimals))::float8 as amount_ui,
       t.price_usd::float8 as price_usd, ${VALUE}::float8 as value_usd, ${CHANGE_24H} as change_24h_pct,
       ${COST}::float8 as cost_basis_usd, ${UNREALIZED}::float8 as unrealized_usd,
       coalesce(p.realized_usd, 0)::float8 as realized_usd, (p.wallet is not null) as traded,
       -- Transfers from before we indexed the token are missing: the amount may be partial (repaired from chain on read).
       not t.launch_indexed as partial_history
     from balances b join tokens t on t.address = b.token
     left join positions p on p.wallet = b.wallet and p.token = b.token
     where b.wallet = $1 and b.amount > 0
     order by ${VALUE} desc nulls last, b.token
     offset $2 limit $3`,
    [wallet, pg.offset, pg.limit + 1],
  );
  const [{ total } = { total: 0 }] = await sql<{ total: number }[]>`select count(*)::int as total from balances where wallet = ${wallet} and amount > 0`;
  const more = rows.length > pg.limit;
  return { wallet, total, holdings: rows.slice(0, pg.limit), next_offset: more ? pg.offset + pg.limit : null };
}

/** Columns of a position row (aliases p, b, t). */
const POSITION_COLS = `
  p.token, t.symbol, t.name, t.image_url, t.decimals, t.price_usd::float8 as price_usd,
  p.bought_tokens::text, p.bought_usd::float8, p.sold_tokens::text, p.sold_usd::float8, p.buys, p.sells,
  ${HELD}::text as held_tokens, (${HELD} / power(10, t.decimals))::float8 as held_ui, ${VALUE}::float8 as value_usd,
  ${COST}::float8 as cost_basis_usd, p.realized_usd::float8, ${UNREALIZED}::float8 as unrealized_usd,
  (p.realized_usd + ${UNREALIZED})::float8 as total_pnl_usd,
  (case when p.bought_usd > 0 then ((p.realized_usd + ${UNREALIZED}) / p.bought_usd * 100)::float8 end) as pnl_pct,
  -- Bought minus sold that is no longer in the wallet (sent elsewhere); not counted as a sale.
  greatest(p.held_tokens - ${HELD}, 0)::text as transferred_out_tokens,
  (p.unbacked_sold_tokens > 0) as unbacked, p.first_trade_at, p.last_trade_at`;

/** Every traded token of a wallet, by total PnL magnitude, paged. */
export async function walletPositions(sql: Sql, wallet: string, pg: { offset: number; limit: number }) {
  const rows = await sql.unsafe(
    `select ${POSITION_COLS}
     from positions p join tokens t on t.address = p.token
     left join balances b on b.token = p.token and b.wallet = p.wallet
     where p.wallet = $1
     order by abs(p.realized_usd + ${UNREALIZED}) desc, p.token
     offset $2 limit $3`,
    [wallet, pg.offset, pg.limit + 1],
  );
  const [{ total } = { total: 0 }] = await sql<{ total: number }[]>`select count(*)::int as total from positions where wallet = ${wallet}`;
  return { total, positions: rows.slice(0, pg.limit), next_offset: rows.length > pg.limit ? pg.offset + pg.limit : null };
}

/** One position: totals plus the wallet's trades of the token (newest first, up to 200). */
export async function walletPosition(sql: Sql, wallet: string, token: string) {
  const [position] = await sql.unsafe(
    `select ${POSITION_COLS}, not t.launch_indexed as partial_history
     from positions p join tokens t on t.address = p.token
     left join balances b on b.token = p.token and b.wallet = p.wallet
     where p.wallet = $1 and p.token = $2`,
    [wallet, token],
  );
  const trades = await sql`
    select tx, log_index, block::text, time, side, token_amount::text, quote_amount::text, usd::float8, price_usd::float8, realized_usd::float8, pool
    from swaps where trader = ${wallet} and token = ${token} order by block desc, log_index desc limit 200`;
  if (position) return { wallet, token, position, trades };
  // Held without trading (airdrop, transfer in): still a holding with zero cost.
  const [held] = await sql`
    select b.amount::text as held_tokens, t.symbol, t.name, t.image_url, t.decimals, t.price_usd::float8 as price_usd,
      (b.amount / power(10, t.decimals) * t.price_usd)::float8 as value_usd
    from balances b join tokens t on t.address = b.token where b.wallet = ${wallet} and b.token = ${token} and b.amount > 0`;
  return held ? { wallet, token, position: null, holding: held, trades } : null;
}

/**
 * Balances of tokens indexed after their launch miss the earlier transfers. Read the true balance on chain
 * at the indexed block and store it, for rows that have been quiet for a while (so no transfer of theirs
 * is in flight between the chain read and the index). Bounded per call.
 */
export async function repairBalances(sql: Sql, rpcUrl: string, wallet: string, max = 60): Promise<number> {
  const [cur] = await sql<{ value: { block: string } }[]>`select value from indexer_state where key = 'cursor'`;
  if (!cur) return 0;
  const block = BigInt(cur.value.block);
  const quietBefore = block - 300n;
  const rows = await sql<{ token: string; amount: string }[]>`
    select b.token, b.amount::text from balances b join tokens t on t.address = b.token
    where b.wallet = ${wallet} and not t.launch_indexed
      and not exists (select 1 from transfers x where x.token = b.token and (x."to" = ${wallet} or x."from" = ${wallet}) and x.block > ${quietBefore.toString()})
    order by b.updated_at limit ${max}`;
  if (!rows.length) return 0;
  const rpc = new Rpc(rpcUrl);
  const data = `0x70a08231${wallet.slice(2).padStart(64, '0')}`;
  const tag = `0x${block.toString(16)}`;
  let fixed = 0;
  for (let i = 0; i < rows.length; i += 10) {
    const chunk = rows.slice(i, i + 10);
    const values = await Promise.all(chunk.map((r) => rpc.call<string>('eth_call', [{ to: r.token, data }, tag], 8_000).catch(() => null)));
    for (const [j, r] of chunk.entries()) {
      const v = values[j];
      if (!v || v === '0x') continue;
      const amount = BigInt(v);
      if (amount === BigInt(r.amount)) {
        await sql`update balances set updated_at = now() where token = ${r.token} and wallet = ${wallet}`;
        continue;
      }
      await sql`update balances set amount = ${amount.toString()}, updated_at = now() where token = ${r.token} and wallet = ${wallet}`;
      fixed++;
    }
  }
  return fixed;
}

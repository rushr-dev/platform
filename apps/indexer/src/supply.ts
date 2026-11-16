// Live token supply, the supply market caps use, and circulating supply.
//
// tokens.total_supply is the on-chain totalSupply() as of tokens.supply_block. Indexed Transfers keep it
// current: a mint (from 0x0) adds and a burn (to 0x0, e.g. ERC20Burnable.burn) subtracts, but only for
// blocks after supply_block (earlier ones are already in the reading). Rows with a null supply_block
// (read before this existed) are left alone until re-read with refreshSupply.
//
// Market cap = price × total_supply (the on-chain totalSupply), as GMGN shows it: tokens "burnt" by a plain
// transfer to 0xdead still count, only real burns (to 0x0, which lower totalSupply) shrink it.
//
// Circulating supply = total_supply minus what sits at the burn addresses (0xdead and friends). Holder
// shares (top 10, dev, snipers...) are measured against it, and the token page shows it. Contracts such
// as lockers, vesting and pools stay in circulation, as on DexScreener.
import type { Sql, TransactionSql } from 'postgres';
import { BURN_ADDRESSES, NATIVE_ETH, type DecodedTransfer } from '@rushr/core';
import type { Address } from 'viem';
import type { Rpc } from './rpc';

const ZERO = NATIVE_ETH.toLowerCase();
/** Burn addresses that hold balances (0x0 never does: balances skip it, and burns there leave totalSupply). */
export const DEAD_WALLETS = BURN_ADDRESSES.map((a) => a.toLowerCase()).filter((a) => a !== ZERO);
const DEAD = new Set(DEAD_WALLETS);

type Db = Sql | TransactionSql;

/** One row `{ supply }`: the supply market cap uses (total_supply) in whole tokens, for `from (…) c` in an update. */
export function capSupplySql(sql: Db, token: string) {
  return sql`select t.total_supply / power(10::numeric, t.decimals) as supply from tokens t where t.address = ${token}`;
}

/**
 * One row `{ supply }`: a token's circulating supply in whole tokens (numeric), for `from (…) c` in an
 * update. Never negative.
 */
export function circulatingSql(sql: Db, token: string) {
  return sql`
    select greatest(t.total_supply - coalesce((
      select sum(b.amount) from balances b where b.token = t.address and b.wallet = any(${DEAD_WALLETS})
    ), 0), 0) / power(10::numeric, t.decimals) as supply
    from tokens t where t.address = ${token}`;
}

/** Net supply change per token from mints and burns (pure; exported for tests). Blocks are kept per row. */
export function supplyDeltas(transfers: Pick<DecodedTransfer, 'token' | 'from' | 'to' | 'amount' | 'block'>[]) {
  const rows: { token: string; block: string; delta: string }[] = [];
  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    if (from === to || t.amount === 0n) continue;
    if (from === ZERO) rows.push({ token: t.token, block: t.block.toString(), delta: t.amount.toString() });
    else if (to === ZERO) rows.push({ token: t.token, block: t.block.toString(), delta: (-t.amount).toString() });
  }
  return rows;
}

/** Tokens whose supply these transfers change (mints, burns, and moves to or from a dead address, which change circulating supply). */
export function supplyTouched(transfers: Pick<DecodedTransfer, 'token' | 'from' | 'to'>[]): string[] {
  const out = new Set<string>();
  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    if (from === ZERO || to === ZERO || DEAD.has(from) || DEAD.has(to)) out.add(t.token);
  }
  return [...out].sort();
}

/**
 * Apply newly inserted transfers to total_supply (mints/burns after supply_block) and refresh the market
 * cap of every token whose supply moved. Rare (most transfers are trades), so it costs
 * nothing on the hot path.
 */
export async function applySupply(tx: TransactionSql, transfers: DecodedTransfer[]) {
  const touched = supplyTouched(transfers);
  if (!touched.length) return;
  // Same lock order as refreshTokenStats (address order), so concurrent writers can't deadlock.
  await tx`select 1 from tokens where address = any(${touched}) order by address for update`;
  const deltas = supplyDeltas(transfers);
  if (deltas.length) {
    await tx`
      update tokens t set total_supply = greatest(t.total_supply + d.delta, 0), updated_at = now()
      from (
        select u.token, sum(u.delta) as delta
        from unnest(${deltas.map((d) => d.token)}::text[], ${deltas.map((d) => d.block)}::bigint[], ${deltas.map((d) => d.delta)}::numeric[]) as u(token, block, delta)
        join tokens k on k.address = u.token
        where k.supply_block is not null and u.block > k.supply_block
        group by u.token
      ) d
      where t.address = d.token`;
  }
  await repriceCaps(tx, touched);
}

/** market_cap_usd = price_usd × total supply, for tokens that have a price. */
export async function repriceCaps(sql: Db, tokens: string[]) {
  if (!tokens.length) return;
  await sql`
    update tokens t set market_cap_usd = t.price_usd * t.total_supply / power(10::numeric, t.decimals), updated_at = now()
    where t.address = any(${tokens}) and t.price_usd is not null`;
}

export interface SupplyChange {
  token: string;
  symbol: string;
  before: string;
  after: string;
  supplyBlock: string;
  marketCapBefore: number | null;
  marketCapAfter: number | null;
}

/**
 * Re-read totalSupply() for these tokens (one batched eth_call each, at one block), store it with that
 * block, and reprice their market caps on it. `dryRun` reads and reports without writing.
 */
export async function refreshSupply(sql: Sql, rpc: Rpc, tokens: string[], opts: { dryRun?: boolean } = {}): Promise<SupplyChange[]> {
  if (!tokens.length) return [];
  const reads = await rpc.totalSupplies(tokens as Address[]);
  const ok = reads.filter((r) => r.totalSupply != null && r.totalSupply > 0n);
  if (!ok.length) return [];
  const rows = await sql<{ address: string; symbol: string; total_supply: string; decimals: number; price_usd: string | null; market_cap_usd: string | null }[]>`
    select t.address, t.symbol, t.total_supply::text, t.decimals, t.price_usd::text, t.market_cap_usd::text
    from tokens t where t.address = any(${ok.map((r) => r.token)})`;
  const byToken = new Map(rows.map((r) => [r.address, r]));
  const changes: SupplyChange[] = [];
  for (const r of ok) {
    const t = byToken.get(r.token);
    if (!t) continue;
    const price = t.price_usd == null ? null : Number(t.price_usd);
    changes.push({
      token: r.token, symbol: t.symbol, before: t.total_supply, after: r.totalSupply!.toString(), supplyBlock: r.supplyBlock.toString(),
      marketCapBefore: t.market_cap_usd == null ? null : Number(t.market_cap_usd),
      marketCapAfter: price == null ? null : price * (Number(r.totalSupply!) / 10 ** t.decimals),
    });
  }
  if (opts.dryRun || !changes.length) return changes;
  const sorted = [...changes].sort((a, b) => (a.token < b.token ? -1 : 1));
  await sql.begin(async (tx) => {
    await tx`select 1 from tokens where address = any(${sorted.map((c) => c.token)}) order by address for update`;
    // Mints and burns already indexed past the reading's block aren't in it: add them back, so a
    // reading taken while the poller runs ahead (or catches up) stays exact.
    await tx`
      update tokens t set supply_block = u.block, updated_at = now(),
        total_supply = greatest(u.supply + coalesce((
          select sum(case when x."from" = ${ZERO} then x.amount else -x.amount end) from transfers x
          where x.token = u.token and x.block > u.block and (x."from" = ${ZERO}) <> (x."to" = ${ZERO})
        ), 0), 0)
      from unnest(${sorted.map((c) => c.token)}::text[], ${sorted.map((c) => c.after)}::numeric[], ${sorted.map((c) => c.supplyBlock)}::bigint[]) as u(token, supply, block)
      where t.address = u.token`;
    await repriceCaps(tx, sorted.map((c) => c.token));
  });
  return changes;
}

/**
 * Tokens whose supply was never read at a known block and that matter: migrated, traded within
 * `days`, or held by at least `minHolders`. Busiest first. Dead and untraded rows are skipped (their cap
 * isn't shown or doesn't move).
 */
export async function pendingSupply(sql: Sql, opts: { limit: number; days?: number; minHolders?: number }): Promise<string[]> {
  const days = opts.days ?? 30;
  const rows = await sql<{ address: string }[]>`
    select t.address from tokens t
    where t.supply_block is null and (
      t.status = 'migrated' or coalesce(t.holders, 0) >= ${opts.minHolders ?? 20}
      or exists (select 1 from swaps s where s.token = t.address and s.time > now() - ${days} * interval '1 day')
    )
    order by t.volume_24h_usd desc nulls last, t.holders desc nulls last, t.address
    limit ${opts.limit}`;
  return rows.map((r) => r.address);
}

/** How many tokens pendingSupply would still return (for the admin status). */
export async function pendingSupplyCount(sql: Sql, opts: { days?: number; minHolders?: number } = {}): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    select count(*)::int as n from tokens t
    where t.supply_block is null and (
      t.status = 'migrated' or coalesce(t.holders, 0) >= ${opts.minHolders ?? 20}
      or exists (select 1 from swaps s where s.token = t.address and s.time > now() - ${opts.days ?? 30} * interval '1 day')
    )`;
  return r?.n ?? 0;
}

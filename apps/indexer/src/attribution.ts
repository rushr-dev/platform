// Swaps credited to a router instead of the wallet that traded.
//
// The trader of a swap is the wallet that ends up with the token (buy) or first gives it up (sell), read
// from the token's Transfer logs in the same transaction (decode.ts resolveTrader). The live socket
// carries no Transfers (cost, see poller.ts), so a swap it writes first falls back to the Swap event's
// sender: the Universal Router. The polling path sees the same swap later with its Transfers and
// resolves the real wallet, but swaps are insert-once, so that answer used to be dropped.
//
// repairTraders fixes that per batch (no RPC: the poll path already has the Transfers), and
// reattributeSwaps re-credits older rows from the indexed transfers table (admin backfill).
import type { Sql, TransactionSql } from 'postgres';
import { INFRA_ADDRESSES } from '@rushr/core';

export const INFRA = INFRA_ADDRESSES.map((a) => a.toLowerCase());
const INFRA_SET = new Set(INFRA);

type Db = Sql | TransactionSql;
export interface Pair {
  wallet: string;
  token: string;
}

/**
 * Swaps already stored with an infra trader (router, PoolManager...) that this batch resolved to a real
 * wallet: re-credit them. Returns the (wallet, token) pairs whose positions need a recompute.
 */
export async function repairTraders(tx: Db, swaps: { tx: string; logIndex: number; token: string; trader: string }[]): Promise<Pair[]> {
  const known = swaps.filter((s) => !INFRA_SET.has(s.trader.toLowerCase()));
  if (!known.length) return [];
  const out: Pair[] = [];
  for (let i = 0; i < known.length; i += 2000) {
    const c = known.slice(i, i + 2000);
    out.push(...(await tx<Pair[]>`
      update swaps s set trader = v.trader
      from unnest(${c.map((s) => s.tx)}::text[], ${c.map((s) => s.logIndex)}::int[], ${c.map((s) => s.trader.toLowerCase())}::text[]) v(tx, li, trader)
      where s.tx = v.tx and s.log_index = v.li and s.trader = any(${INFRA}) and s.trader <> v.trader
      returning v.trader as wallet, s.token`));
  }
  return dedupe(out);
}

const dedupe = (pairs: Pair[]) => [...new Map(pairs.map((p) => [`${p.wallet}|${p.token}`, p])).values()];

export interface Reattribution {
  /** Router-credited swaps looked at (newest first, below `before`). */
  checked: number;
  /** Of those, how many the indexed transfers resolve to a wallet. */
  resolved: number;
  /** Rows changed (0 on a dry run). */
  updated: number;
  pairs: Pair[];
  /** Pass as `before` to continue (null when done). */
  next: { block: string; logIndex: number } | null;
  sample: { tx: string; token: string; side: string; usd: number | null; wallet: string }[];
}

/**
 * Re-credit up to `limit` router-credited swaps from the transfers table, newest first, keyset on
 * (block, log_index) below `before`. Same rule as resolveTrader: buys go to the last receiver of the
 * token in the tx, sells to the first sender, skipping infra addresses and known pools. Rows without a
 * resolvable transfer are left as they are.
 */
export async function reattributeSwaps(
  sql: Sql,
  opts: { limit: number; before?: { block: string; logIndex: number } | null; write?: boolean },
): Promise<Reattribution> {
  const before = opts.before ?? null;
  const rows = await sql<{ tx: string; log_index: number; block: string; token: string; side: string; usd: number | null; wallet: string | null }[]>`
    with r as (
      select s.tx, s.log_index, s.block, s.token, s.side, s.usd from swaps s
      where s.trader = any(${INFRA})
        and (${before?.block ?? null}::bigint is null or (s.block, s.log_index) < (${before?.block ?? null}::bigint, ${before?.logIndex ?? 0}::int))
      order by s.block desc, s.log_index desc
      limit ${opts.limit}
    )
    select r.tx, r.log_index, r.block::text, r.token, r.side, r.usd::float8 as usd, (
      select case when r.side = 'buy' then (array_agg(t."to" order by t.log_index desc))[1]
                  else (array_agg(t."from" order by t.log_index))[1] end
      from transfers t
      where t.tx = r.tx and t.token = r.token
        and (case when r.side = 'buy' then t."to" else t."from" end) <> all(${INFRA})
        and not exists (select 1 from pools p where p.id = (case when r.side = 'buy' then t."to" else t."from" end))
    ) as wallet
    from r`;
  const hits = rows.filter((r): r is typeof r & { wallet: string } => !!r.wallet);
  let updated = 0;
  let pairs: Pair[] = [];
  if (opts.write && hits.length) {
    const res = await sql<Pair[]>`
      update swaps s set trader = v.wallet
      from unnest(${hits.map((h) => h.tx)}::text[], ${hits.map((h) => h.log_index)}::int[], ${hits.map((h) => h.wallet)}::text[]) v(tx, li, wallet)
      where s.tx = v.tx and s.log_index = v.li and s.trader = any(${INFRA})
      returning v.wallet as wallet, s.token`;
    updated = res.length;
    pairs = dedupe([...res]);
  } else {
    pairs = dedupe(hits.map((h) => ({ wallet: h.wallet, token: h.token })));
  }
  const last = rows.at(-1);
  return {
    checked: rows.length, resolved: hits.length, updated, pairs,
    next: rows.length === opts.limit && last ? { block: last.block, logIndex: last.log_index } : null,
    sample: hits.slice(0, 10).map((h) => ({ tx: h.tx, token: h.token, side: h.side, usd: h.usd, wallet: h.wallet })),
  };
}

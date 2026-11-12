// PONS bonding curves: progress and graduation from each curve's own parameters.
//
// Curves graduate at their own `graduationThreshold()`, in their own quote (`pairToken()`): 4.2 ETH
// for ETH curves, ~354.9 of the quote for others (2026-11-12). Measuring every curve in USD against
// 4.2 ETH read 100% for curves that were nowhere near done, so they sat in Almost bonded forever.
// `graduated()` is the truth for whether a curve finished.
import type { Sql, TransactionSql } from 'postgres';
import { toFunctionSelector, type Hex } from 'viem';
import type { Rpc } from './rpc';

const THRESHOLD = toFunctionSelector('graduationThreshold()');
const GRADUATED = toFunctionSelector('graduated()');
/** Fallback when a curve doesn't answer graduationThreshold() (observed target of ETH curves). */
const DEFAULT_THRESHOLD = 4_200_000_000_000_000_000n;
/** Progress is capped here until graduated() confirms the curve finished. */
const MAX_UNCONFIRMED = 0.999;

/** Thresholds never change, so they're cached for the life of the isolate. */
const thresholds = new Map<string, bigint>();

export async function curveThresholds(rpc: Rpc, curves: string[]): Promise<Map<string, bigint>> {
  const missing = [...new Set(curves)].filter((c) => !thresholds.has(c));
  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const res = await rpc.batch<Hex>(chunk.map((c) => ({ method: 'eth_call', params: [{ to: c, data: THRESHOLD }, 'latest'] })));
    chunk.forEach((c, j) => {
      const r = res[j];
      const v = r && r.length >= 66 ? BigInt(r.slice(0, 66)) : 0n;
      thresholds.set(c, v > 0n ? v : DEFAULT_THRESHOLD);
    });
  }
  return new Map(curves.map((c) => [c, thresholds.get(c) ?? DEFAULT_THRESHOLD]));
}

/**
 * Recompute bonding progress of PONS tokens still on their curve (all of them, or `tokens`):
 * net quote paid into the curve (raw units) / the curve's threshold (same units).
 */
export async function updateCurveProgress(sql: Sql | TransactionSql, rpc: Rpc, tokens?: string[]): Promise<number> {
  const rows = await sql<{ address: string; main_pool: string }[]>`
    select address, main_pool from tokens
    where launchpad = 'pons' and status <> 'migrated' and length(main_pool) = 42
      ${tokens ? sql`and address = any(${tokens})` : sql``}`;
  if (!rows.length) return 0;
  const th = await curveThresholds(rpc, rows.map((r) => r.main_pool));
  const r = await sql`
    update tokens t set bonding_progress = least(${MAX_UNCONFIRMED}, greatest(0,
        (select coalesce(sum(case when s.side = 'buy' then s.quote_amount else -s.quote_amount end), 0)
         from swaps s where s.token = t.address and s.pool = t.main_pool) / v.th))
    from unnest(${rows.map((x) => x.address)}::text[], ${rows.map((x) => th.get(x.main_pool)!.toString())}::numeric[]) v(addr, th)
    where t.address = v.addr and t.status <> 'migrated'`;
  return r.count;
}

/**
 * Curves close to their threshold: ask graduated(). Finished ones become migrated (the graduation
 * event may have been missed, or use a topic we don't decode). Returns the tokens that graduated.
 */
export async function checkGraduations(sql: Sql, rpc: Rpc, minProgress = 0.9): Promise<string[]> {
  const rows = await sql<{ address: string; main_pool: string }[]>`
    select address, main_pool from tokens
    where launchpad = 'pons' and status <> 'migrated' and length(main_pool) = 42 and coalesce(bonding_progress, 0) >= ${minProgress}`;
  const done: string[] = [];
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const res = await rpc.batch<Hex>(chunk.map((r) => ({ method: 'eth_call', params: [{ to: r.main_pool, data: GRADUATED }, 'latest'] })));
    chunk.forEach((r, j) => {
      const v = res[j];
      if (v && v.length >= 66 && BigInt(v.slice(0, 66)) === 1n) done.push(r.address);
    });
  }
  if (done.length) {
    await sql`update tokens set status = 'migrated', bonding_progress = 1, migrated_at = coalesce(migrated_at, now())
              where address = any(${done})`;
  }
  return done;
}

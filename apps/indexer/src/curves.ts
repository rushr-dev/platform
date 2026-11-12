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
const NATIVE = '0x0000000000000000000000000000000000000000';

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
 * Bonding progress of PONS tokens still on their curve (all of them, or `opts.tokens`, or only those
 * traded in the last `opts.activeSeconds`): the curve's actual reserve (its ETH balance, or its balance
 * of the quote token) over its own threshold. Summing trades over-counted (fees never reach the reserve:
 * QZO read 86% with 2.16 of 4.2 ETH in the curve).
 */
export async function updateCurveProgress(
  sql: Sql | TransactionSql,
  rpc: Rpc,
  opts: { tokens?: string[]; activeSeconds?: number } = {},
): Promise<number> {
  const rows = await sql<{ address: string; main_pool: string; quote: string | null }[]>`
    select address, main_pool, quote from tokens
    where launchpad = 'pons' and status <> 'migrated' and length(main_pool) = 42
      ${opts.tokens ? sql`and address = any(${opts.tokens})` : sql``}
      ${opts.activeSeconds ? sql`and price_at > now() - ${opts.activeSeconds} * interval '1 second'` : sql``}`;
  if (!rows.length) return 0;
  const th = await curveThresholds(rpc, rows.map((r) => r.main_pool));
  const reserves: (Hex | null)[] = [];
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    reserves.push(
      ...(await rpc.batch<Hex>(
        chunk.map((r) => {
          const quote = (r.quote ?? NATIVE).toLowerCase();
          return quote === NATIVE
            ? { method: 'eth_getBalance', params: [r.main_pool, 'latest'] }
            : { method: 'eth_call', params: [{ to: quote, data: `0x70a08231${r.main_pool.slice(2).padStart(64, '0')}` }, 'latest'] };
        }),
      )),
    );
  }
  const addrs: string[] = [];
  const progress: number[] = [];
  rows.forEach((r, i) => {
    const raw = reserves[i];
    if (!raw || raw === '0x') return;
    const bal = BigInt(raw.length > 66 ? raw.slice(0, 66) : raw);
    const t = th.get(r.main_pool)!;
    addrs.push(r.address);
    progress.push(Math.min(MAX_UNCONFIRMED, Number((bal * 1_000_000n) / t) / 1_000_000));
  });
  if (!addrs.length) return 0;
  const res = await sql`
    update tokens t set bonding_progress = v.p
    from unnest(${addrs}::text[], ${progress}::float8[]) v(addr, p)
    where t.address = v.addr and t.status <> 'migrated'`;
  return res.count;
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

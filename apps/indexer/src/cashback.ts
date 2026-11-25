// Cashback: 30% of the platform fee each trader paid, accrued per confirmed trade in trades_ledger (ledger.ts) and
// paid weekly from the treasury Safe in one batch (packages/trade/scripts/cashback-batch.ts), which both owners sign.
//
//   GET  /v1/me/cashback   earned, paid, in this week's batch and owed per fee token, and recent payouts
import { Hono } from 'hono';
import type { Sql, TransactionSql } from 'postgres';
import { CASHBACK_MIN, DEFAULT_TRADE_CONFIG } from '@rushr/trade';
import { limit, requireMember, PRIVATE, type Ctx } from './agents/http';

type Db = Sql | TransactionSql;

export interface OwedRow {
  fee_token: string;
  trades: number;
  accrued: string;
  paid: string;
  pending: string;
  owed: string;
}

/** Per fee token: accrued on confirmed trades, paid, in a batch waiting for the Safe, and owed = the rest. */
export async function owedFor(sql: Db, wallet: string): Promise<OwedRow[]> {
  const rows = await sql<Omit<OwedRow, 'owed'>[]>`
    with a as (
      select lower(fee_token) as fee_token, count(*)::int as trades, sum(cashback_accrual) as accrued from trades_ledger
      where trader = ${wallet} and status = 'confirmed' and cashback_accrual > 0 group by 1),
    p as (
      select lower(fee_token) as fee_token, coalesce(sum(amount) filter (where status = 'paid'), 0) as paid,
        coalesce(sum(amount) filter (where status = 'pending'), 0) as pending
      from cashback_payouts where wallet = ${wallet} group by 1)
    select a.fee_token, a.trades, a.accrued::text, coalesce(p.paid, 0)::text as paid, coalesce(p.pending, 0)::text as pending
    from a left join p using (fee_token)`;
  return rows.map((r) => {
    const owed = BigInt(r.accrued) - BigInt(r.paid) - BigInt(r.pending);
    return { ...r, owed: (owed > 0n ? owed : 0n).toString() };
  });
}

export const cashback = new Hono<Ctx>();

cashback.get('/me/cashback', async (c) => {
  const m = requireMember(c);
  await limit(c, 'read');
  const sql = c.var.sql;
  const [rows, payouts] = await Promise.all([
    owedFor(sql, m.wallet),
    sql`select batch, fee_token, amount::text, status, tx_hash, created_at, paid_at from cashback_payouts
      where wallet = ${m.wallet} and status <> 'void' order by created_at desc limit 20`,
  ]);
  return c.json(
    {
      shareBps: DEFAULT_TRADE_CONFIG.cashbackShareBps,
      cashback: rows,
      payouts,
      payout: {
        schedule: 'weekly',
        /** Owed below this waits for a later week (raw units per fee token). */
        min: Object.fromEntries(Object.entries(CASHBACK_MIN).map(([k, v]) => [k, v.toString()])),
      },
    },
    200,
    PRIVATE,
  );
});

// Cashback: 30% of the platform fee each trader paid, accrued per confirmed trade in trades_ledger (ledger.ts) and
// paid every Sunday (UTC) from the treasury Safe in one batch (packages/trade/scripts/cashback-batch.ts), which both owners sign.
//
//   GET  /v1/me/cashback   earned (cashback + referral share), paid, in this week's batch and owed per fee token, and recent payouts
import { Hono } from 'hono';
import type { Sql, TransactionSql } from 'postgres';
import { CASHBACK_MIN, DEFAULT_TRADE_CONFIG, NATIVE_FEE_TOKEN, nextPayoutDate } from '@rushr/trade';
import { limit, requireMember, PRIVATE, type Ctx } from './agents/http';

type Db = Sql | TransactionSql;

export interface OwedRow {
  fee_token: string;
  /** The wallet's own trades that earned cashback. */
  trades: number;
  /** Everything earned: cashback + referral. Payouts cover both in one transfer. */
  accrued: string;
  /** Cashback on the wallet's own trades. */
  cashback: string;
  /** The wallet's referral share of the fees its referees paid (agents/referrals.ts). */
  referral: string;
  paid: string;
  pending: string;
  owed: string;
}

/**
 * Per fee token: accrued on confirmed trades (cashback as a trader + referral share as a referrer), paid, in a batch
 * waiting for the Safe, and owed = the rest. One payout per wallet and token covers both.
 */
export async function owedFor(sql: Db, wallet: string): Promise<OwedRow[]> {
  const rows = await sql<Omit<OwedRow, 'owed'>[]>`
    with c as (
      select lower(fee_token) as fee_token, count(*)::int as trades, sum(cashback_accrual) as cashback from trades_ledger
      where trader = ${wallet} and status = 'confirmed' and cashback_accrual > 0 group by 1),
    r as (
      select lower(fee_token) as fee_token, sum(referrer_accrual) as referral from trades_ledger
      where referrer = ${wallet} and status = 'confirmed' and referrer_accrual > 0 group by 1),
    a as (
      select fee_token, coalesce(c.trades, 0) as trades, coalesce(c.cashback, 0) as cashback, coalesce(r.referral, 0) as referral
      from c full join r using (fee_token)),
    p as (
      select lower(fee_token) as fee_token, coalesce(sum(amount) filter (where status = 'paid'), 0) as paid,
        coalesce(sum(amount) filter (where status = 'pending'), 0) as pending
      from cashback_payouts where wallet = ${wallet} group by 1)
    select a.fee_token, a.trades, (a.cashback + a.referral)::text as accrued, a.cashback::text as cashback, a.referral::text as referral,
      coalesce(p.paid, 0)::text as paid, coalesce(p.pending, 0)::text as pending
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
  const [rows, payouts, [eth]] = await Promise.all([
    owedFor(sql, m.wallet),
    sql<{ batch: string; fee_token: string; amount: string; status: string; tx_hash: string | null; created_at: Date; paid_at: Date | null }[]>`
      select batch, fee_token, amount::text, status, tx_hash, created_at, paid_at from cashback_payouts
      where wallet = ${m.wallet} and status <> 'void' order by created_at desc limit 20`,
    sql<{ value: { usd: number } }[]>`select value from indexer_state where key = 'eth_usd'`,
  ]);
  // USD at today's ETH price (USDG at face value), so a member reads one number. null when the price is unknown.
  const ethUsd = eth?.value.usd ?? null;
  const usdOf = (raw: string | bigint, token: string): number | null => {
    const v = BigInt(raw);
    if (token.toLowerCase() === NATIVE_FEE_TOKEN) return ethUsd == null ? null : (Number(v) / 1e18) * ethUsd;
    return Number(v) / 1e6;
  };
  const usdSum = (pick: (r: OwedRow) => bigint): number | null => {
    let t = 0;
    for (const r of rows) {
      const u = usdOf(pick(r), r.fee_token);
      if (u == null) return null;
      t += u;
    }
    return Math.round(t * 10_000) / 10_000;
  };
  return c.json(
    {
      shareBps: DEFAULT_TRADE_CONFIG.cashbackShareBps,
      cashback: rows,
      payouts: payouts.map((p) => ({ ...p, usd: usdOf(p.amount, p.fee_token) })),
      /** USD totals at today's ETH price. nextPayout = owed + already in this week's batch. */
      usd: {
        ethUsd,
        earned: usdSum((r) => BigInt(r.accrued)),
        /** The two parts of `earned`. */
        cashback: usdSum((r) => BigInt(r.cashback)),
        referral: usdSum((r) => BigInt(r.referral)),
        paid: usdSum((r) => BigInt(r.paid)),
        nextPayout: usdSum((r) => BigInt(r.owed) + BigInt(r.pending)),
      },
      payout: {
        schedule: 'weekly',
        /** The next payout day (UTC). */
        next: nextPayoutDate(),
        weekday: 'Sunday',
        /** Owed below this waits for a later week (raw units per fee token). */
        min: Object.fromEntries(Object.entries(CASHBACK_MIN).map(([k, v]) => [k, v.toString()])),
      },
    },
    200,
    PRIVATE,
  );
});

/**
 * GET /v1/me/referrals: the member's referral link (their handle is the code), who signed up with it, how many of
 * them traded, and the referral share earned so far (paid with cashback every Sunday). Referees are listed by
 * handle only, newest first.
 */
cashback.get('/me/referrals', async (c) => {
  const m = requireMember(c);
  await limit(c, 'read');
  const sql = c.var.sql;
  const [[counts], joined, earned, [eth]] = await Promise.all([
    sql<{ joined: number; traded: number; trades: number }[]>`
      select (select count(*)::int from referrals where referrer_id = ${m.id}) as joined,
        (select count(distinct trader)::int from trades_ledger where referrer = ${m.wallet} and status = 'confirmed') as traded,
        (select count(*)::int from trades_ledger where referrer = ${m.wallet} and status = 'confirmed') as trades`,
    sql<{ handle: string; kind: string; joined_at: Date }[]>`
      select mb.handle, mb.kind, r.created_at as joined_at from referrals r join members mb on mb.id = r.referee_id
      where r.referrer_id = ${m.id} and mb.status = 'active' order by r.created_at desc limit 50`,
    sql<{ fee_token: string; amount: string }[]>`
      select lower(fee_token) as fee_token, sum(referrer_accrual)::text as amount from trades_ledger
      where referrer = ${m.wallet} and status = 'confirmed' and referrer_accrual > 0 group by 1`,
    sql<{ value: { usd: number } }[]>`select value from indexer_state where key = 'eth_usd'`,
  ]);
  const ethUsd = eth?.value.usd ?? null;
  let usd: number | null = 0;
  for (const e of earned) {
    const v = Number(BigInt(e.amount));
    const u = e.fee_token === NATIVE_FEE_TOKEN ? (ethUsd == null ? null : (v / 1e18) * ethUsd) : v / 1e6;
    usd = u == null || usd == null ? null : usd + u;
  }
  const cfg = DEFAULT_TRADE_CONFIG;
  return c.json(
    {
      code: m.handle,
      link: `https://app.rushr.trade/?ref=${m.handle}`,
      /** What a referee gets off the fee, and the referrer's share of what they pay, both in bps of the fee. */
      discountBps: cfg.referralDiscountBps,
      shareBps: cfg.referrerShareBps,
      joined: counts?.joined ?? 0,
      traded: counts?.traded ?? 0,
      trades: counts?.trades ?? 0,
      referees: joined.map((r) => ({ handle: r.handle, kind: r.kind, joinedAt: r.joined_at })),
      earned: earned.map((e) => ({ fee_token: e.fee_token, amount: e.amount })),
      usd: { ethUsd, earned: usd == null ? null : Math.round(usd * 10_000) / 10_000 },
      payout: { schedule: 'weekly', next: nextPayoutDate(), weekday: 'Sunday' },
    },
    200,
    PRIVATE,
  );
});

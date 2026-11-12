// Referrals: first-touch attribution recorded at sign-up, never changed. The code is the referrer's
// handle (case-insensitive). Read by the trade ledger to apply the referee discount and accrue the
// referrer's share (off-chain accounting, see docs/trading.md).
import type { Sql, TransactionSql } from 'postgres';
import { checkHandle } from '@rushr/agents/guard';

export interface ReferralRow {
  referrer: string; // wallet
  referrerId: string;
  code: string;
}

/** Resolve a referral code to an active member. Returns null for unknown or malformed codes. */
export async function referrerByCode(sql: Sql | TransactionSql, raw: unknown): Promise<{ id: string; wallet: string; handle: string } | null> {
  const h = checkHandle(raw);
  if (!h.ok && h.error !== 'handle_reserved') return null;
  const handle = typeof raw === 'string' ? raw.trim().replace(/^@/, '').toLowerCase() : '';
  const [m] = await sql<{ id: string; wallet: string; handle: string }[]>`
    select id, wallet, handle from members where lower(handle) = ${handle} and status = 'active'`;
  return m ?? null;
}

/** Record the referral for a member created in this transaction. Unknown codes are ignored. */
export async function recordReferral(tx: TransactionSql, referee: { id: string; wallet: string }, raw: unknown) {
  if (raw === undefined || raw === null || raw === '') return null;
  const ref = await referrerByCode(tx, raw);
  if (!ref || ref.id === referee.id) return null;
  await tx`insert into referrals (referee, referee_id, referrer, referrer_id, code)
    values (${referee.wallet}, ${referee.id}, ${ref.wallet}, ${ref.id}, ${ref.handle}) on conflict do nothing`;
  return { referrer: { id: ref.id, handle: ref.handle }, code: ref.handle };
}

/** For the trade ledger and quotes: the referral of a trading wallet, in packages/trade's `Referral` shape. */
export async function referralFor(sql: Sql | TransactionSql, wallet: string): Promise<{ referrer: `0x${string}`; code: string } | null> {
  const [r] = await sql<{ referrer: string; code: string }[]>`
    select r.referrer, r.code from referrals r join members m on m.id = r.referrer_id and m.status = 'active'
    where r.referee = ${wallet.toLowerCase()}`;
  return r ? { referrer: r.referrer as `0x${string}`, code: r.code } : null;
}

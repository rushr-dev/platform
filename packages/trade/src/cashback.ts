import { encodeFunctionData, erc20Abi, getAddress, type Address } from 'viem';

/**
 * Cashback payouts (decided 2026-11-25). Each confirmed trade accrues the trader's cashback in the trade ledger
 * (`cashbackOf`). Members claim it any time (apps/indexer/src/cashback.ts, sent from a payer wallet); as a
 * fallback, everything owed above the minimum can be paid from the treasury Safe in one batch that both owners
 * sign in Safe's Transaction Builder. This module is the pure part: minimums, which wallets a batch pays, and
 * the transfer for one payout. scripts/cashback-batch.ts does the reading, bookkeeping and on-chain check.
 */

export const NATIVE_FEE_TOKEN = '0x0000000000000000000000000000000000000000';

/**
 * Smallest amount paid out, per fee token (raw units): dust only, so almost every payout goes out on the next
 * payout day; anything below carries over. 0.00001 ETH (a few cents), 0.01 USDG.
 */
export const CASHBACK_MIN: Record<string, bigint> = {
  [NATIVE_FEE_TOKEN]: 10n ** 13n,
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 10_000n,
};

/** Cashback is paid weekly on this day (UTC, 0 = Sunday), from the treasury Safe. */
export const CASHBACK_PAYOUT_WEEKDAY = 0;

/** The next payout day on or after `now` (UTC date, YYYY-MM-DD); today counts until the end of the day. */
export function nextPayoutDate(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + ((CASHBACK_PAYOUT_WEEKDAY - d.getUTCDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

export interface Owed {
  wallet: string;
  feeToken: string;
  owed: bigint;
}

/** What gets paid this week: owed at least the minimum, in a fee token we know how to pay. Largest first. */
export function payable(rows: Owed[], min: Record<string, bigint> = CASHBACK_MIN): Owed[] {
  return rows
    .filter((r) => {
      const m = min[r.feeToken.toLowerCase()];
      return m != null && r.owed >= m;
    })
    .sort((a, b) => (b.owed > a.owed ? 1 : b.owed < a.owed ? -1 : a.wallet.localeCompare(b.wallet)));
}

/** One transfer per payout: ETH as a plain value transfer, a token as `transfer(wallet, amount)`. */
export function payoutTx(p: Owed): { to: Address; value: string; data: `0x${string}` | null } {
  if (p.feeToken.toLowerCase() === NATIVE_FEE_TOKEN) return { to: getAddress(p.wallet), value: p.owed.toString(), data: null };
  return {
    to: getAddress(p.feeToken),
    value: '0',
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [getAddress(p.wallet), p.owed] }),
  };
}

/** A Safe Transaction Builder file (Upload a JSON) for one batch: every payout as one transaction in it. */
export function txBuilderFile(o: { safe: Address; chainId: number; batch: string; payouts: Owed[]; createdAt?: number }) {
  return {
    version: '1.0',
    chainId: String(o.chainId),
    createdAt: o.createdAt ?? Date.now(),
    meta: {
      name: `Rushr cashback ${o.batch}`,
      description: `Cashback batch: ${o.payouts.length} payout(s) of what each trader is owed (30% of the platform fee they paid).`,
      txBuilderVersion: '1.16.5',
      createdFromSafeAddress: getAddress(o.safe),
      createdFromOwnerAddress: '',
      checksum: '',
    },
    transactions: o.payouts.map((p) => ({ ...payoutTx(p), contractMethod: null, contractInputsValues: null })),
  };
}

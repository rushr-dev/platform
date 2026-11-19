import type { Address, Hex } from 'viem';
import type { TradeConfig } from './config';
import { BPS } from './fees';
import type { Quote, Referral, TradeSource } from './types';

/**
 * Referrals are accounted OFF-CHAIN (decided 2026-11-12): a referred trader pays the discounted
 * rate on-chain (the router simply charges fewer bps), the whole fee still goes to the treasury, and the
 * referrer's share accrues in our database for a later payout. No payouts are built yet.
 */

/**
 * Fee rate for this trader: the base rate minus the referee discount (when referred) and the $RUSHR holder
 * discount (`holderBps`, from `holderDiscountBps`), which stack. Rounded in the trader's favour: the router
 * takes whole bps, so 0.25% with 10% off is 0.22%.
 */
export function effectiveFeeBps(cfg: TradeConfig, referral?: Referral | null, holderBps = 0): number {
  const off = Math.min(10_000, (referral ? cfg.referralDiscountBps : 0) + Math.max(0, holderBps));
  if (off === 0) return cfg.feeBps;
  return cfg.feeBps - Math.ceil((cfg.feeBps * off) / 10_000);
}

/** Referrer's accrual on a collected fee (rounded down). */
export function referrerAccrual(feeAmount: bigint, cfg: TradeConfig, referral?: Referral | null): bigint {
  return referral ? (feeAmount * BigInt(cfg.referrerShareBps)) / BPS : 0n;
}

/** What the referee saved vs. the base rate, given the fee basis (input on buys, gross output on sells). */
export function referralDiscount(feeBasis: bigint, cfg: TradeConfig, appliedBps: number): bigint {
  return savedBetween(feeBasis, cfg.feeBps, appliedBps);
}

/** Fee saved by paying `toBps` instead of `fromBps` on `feeBasis`. */
export function savedBetween(feeBasis: bigint, fromBps: number, toBps: number): bigint {
  const d = (feeBasis * BigInt(fromBps)) / BPS - (feeBasis * BigInt(toBps)) / BPS;
  return d > 0n ? d : 0n;
}

/**
 * One row per executed trade: everything the off-chain fee and referral ledger needs. Built from the
 * quote at submit time (`status: 'submitted'`), then completed from the receipt (`status: 'confirmed'`)
 * with the fee actually paid, which is the number payouts must use.
 * Proposed table: see docs/trading.md "Referral ledger".
 */
export interface TradeRecord {
  status: 'quoted' | 'submitted' | 'confirmed' | 'failed';
  chainId: number;
  txHash: Hex | null;
  blockNumber: bigint | null;
  /** Unix seconds (block time once confirmed). */
  timestamp: number;
  trader: Address;
  source: TradeSource;
  side: 'buy' | 'sell';
  token: Address;
  quoteAsset: 'ETH' | 'USDG';
  venue: string;
  poolId: Hex;
  router: Address;
  amountIn: bigint;
  /** Expected at quote time; actual once confirmed. */
  amountOut: bigint;
  feeToken: Address;
  baseFeeBps: number;
  feeBps: number;
  feeAmount: bigint;
  referrer: Address | null;
  referralCode: string | null;
  referralDiscountAmount: bigint;
  referrerShareBps: number;
  referrerAccrual: bigint;
}

export function draftTradeRecord(q: Quote, cfg: TradeConfig, router: Address, now = Math.floor(Date.now() / 1000)): TradeRecord {
  const ref = q.request.referral ?? null;
  return {
    status: 'quoted',
    chainId: 4663,
    txHash: null,
    blockNumber: null,
    timestamp: now,
    trader: q.request.trader,
    source: q.request.source ?? { kind: 'web' },
    side: q.request.side,
    token: q.request.token,
    quoteAsset: q.request.quoteAsset,
    venue: q.pool.venue,
    poolId: q.pool.id,
    router,
    amountIn: q.amountIn,
    amountOut: q.amountOut,
    feeToken: q.fee.feeToken,
    baseFeeBps: q.fee.baseFeeBps,
    feeBps: q.fee.feeBps,
    feeAmount: q.fee.feeAmount,
    referrer: ref?.referrer ?? null,
    referralCode: ref?.code ?? null,
    referralDiscountAmount: q.fee.referralDiscountAmount,
    referrerShareBps: ref ? cfg.referrerShareBps : 0,
    referrerAccrual: q.fee.referrerAccrual,
  };
}

/** Completes a record from what the chain says (e.g. the simulation or receipt transfer analysis). */
export function confirmTradeRecord(r: TradeRecord, actual: { txHash: Hex; blockNumber: bigint; timestamp: number; amountOut: bigint; feePaid: bigint }, cfg: TradeConfig): TradeRecord {
  return {
    ...r,
    status: 'confirmed',
    txHash: actual.txHash,
    blockNumber: actual.blockNumber,
    timestamp: actual.timestamp,
    amountOut: actual.amountOut,
    feeAmount: actual.feePaid,
    referrerAccrual: r.referrer ? (actual.feePaid * BigInt(cfg.referrerShareBps)) / BPS : 0n,
  };
}

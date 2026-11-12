import { TradeError } from './errors';

export const BPS = 10_000n;

export type Side = 'buy' | 'sell';

/**
 * Fee on an amount, rounded down (the user never pays more than the stated rate).
 * Matches the Universal Router's PAY_PORTION: balance * bips / 10_000.
 */
export function feeOf(amount: bigint, feeBps: number): bigint {
  if (amount < 0n) throw new TradeError('INVALID_AMOUNT', 'amount must be >= 0');
  return (amount * BigInt(feeBps)) / BPS;
}

/** Buys: the fee comes off the quote-side input before the swap. */
export function splitBuyInput(amountIn: bigint, feeBps: number): { fee: bigint; swapAmount: bigint } {
  if (amountIn <= 0n) throw new TradeError('INVALID_AMOUNT', 'amount must be > 0');
  const fee = feeOf(amountIn, feeBps);
  return { fee, swapAmount: amountIn - fee };
}

/** Sells: the fee comes off the quote-side output after the swap. */
export function splitSellOutput(grossOut: bigint, feeBps: number): { fee: bigint; netOut: bigint } {
  const fee = feeOf(grossOut, feeBps);
  return { fee, netOut: grossOut - fee };
}

/** Minimum acceptable amount for a quoted amount and slippage (rounded down). */
export function minOut(quoted: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000)
    throw new TradeError('INVALID_SLIPPAGE', 'slippage must be 0..9999 bps', { slippageBps });
  return (quoted * (BPS - BigInt(slippageBps))) / BPS;
}

/**
 * On sells the router checks the NET amount (after PAY_PORTION). The swap itself gets a gross minimum
 * that is consistent with it: grossMin * (1 - fee) >= netMin.
 */
export function sellMinimums(quotedGross: bigint, feeBps: number, slippageBps: number): { minGross: bigint; minNet: bigint } {
  const minGross = minOut(quotedGross, slippageBps);
  return { minGross, minNet: splitSellOutput(minGross, feeBps).netOut };
}

/** Effective slippage: user slippage plus measured token tax, capped at 50%. */
export function slippageWithTax(slippageBps: number, buyTaxBps = 0, sellTaxBps = 0, side: Side = 'buy'): number {
  const tax = side === 'buy' ? buyTaxBps : sellTaxBps;
  return Math.min(5000, slippageBps + Math.max(0, Math.ceil(tax)));
}

/** Price impact in bps of an executed rate vs. a spot (mid) rate, both expressed as out-per-in scaled amounts. */
export function priceImpactBps(spotOut: bigint, quotedOut: bigint): number {
  if (spotOut <= 0n || quotedOut >= spotOut) return 0;
  return Number(((spotOut - quotedOut) * BPS) / spotOut);
}

export interface FeeBreakdown {
  side: Side;
  /** Quote asset (ETH/WETH/USDG) the fee is paid in. */
  feeToken: `0x${string}`;
  /** Rate applied to this trade (after any referral discount). */
  feeBps: number;
  /** Platform rate before discounts. */
  baseFeeBps: number;
  feeAmount: bigint;
  /** Referral: discount vs. the base rate, and the referrer's accrual (off-chain), both in feeToken. */
  referralDiscountAmount: bigint;
  referrerAccrual: bigint;
  /** Venue's own fees, informational (pool fee tier, PONS curve fee + creator tax). */
  venueFeeBps: number;
  venueFeeLabel: string;
}

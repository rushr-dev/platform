/**
 * Which trades may set a token's price (candles, current price, market cap, ATH).
 *
 * Arbitrage bots route dust through pools: e.g. 0.0000000025 PONS for 0.000002 USDG (2 raw units).
 * At that size integer rounding makes the implied price 400-6,000x off (or 0), and one such trade
 * draws a wick to a $4,000B market cap. Those trades stay in the trade list (with their USD value);
 * they just don't price the token.
 */

/** Below this a trade is dust: rounding dominates its implied price. */
export const MIN_PRICING_USD = 0.01;
/** A small trade this far from the reference price (either way) is treated as an outlier. */
export const MAX_DEVIATION = 3;
/** Trades at least this big may move the price any distance (real pumps and dumps). */
export const TRUSTED_USD = 50;

export interface PriceCandidate {
  /** USD value of the trade (quote side). */
  usd: number;
  /** Implied USD price per token. */
  price: number;
  /** Quote amount in raw units (0 = nothing paid or received). */
  quoteRaw: bigint;
  /** Recent accepted price of the token, if any. */
  reference: number | null;
}

export function acceptsPrice(c: PriceCandidate): boolean {
  if (!Number.isFinite(c.price) || c.price <= 0 || c.quoteRaw === 0n) return false;
  if (!(c.usd >= MIN_PRICING_USD)) return false;
  if (c.reference && c.reference > 0 && c.usd < TRUSTED_USD) {
    const ratio = c.price / c.reference;
    if (ratio > MAX_DEVIATION || ratio < 1 / MAX_DEVIATION) return false;
  }
  return true;
}

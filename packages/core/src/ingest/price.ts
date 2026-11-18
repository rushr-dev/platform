/**
 * Which trades may set a token's price (candles, current price, market cap, ATH).
 *
 * Arbitrage bots route dust through pools: e.g. 0.0000000025 PONS for 0.000002 USDG (2 raw units).
 * At that size integer rounding makes the implied price 400-6,000x off (or 0), and one such trade
 * draws a wick to a $4,000B market cap. Those trades stay in the trade list (with their USD value);
 * they just don't price the token.
 *
 * Bots also route real money through thin side pools (someone's $50 Uniswap v4 pool next to the
 * token's curve). A $62 buy there filled at 44x the curve price and drew a $1.6M wick on a $37K
 * token (IDLEX, 2026-11-18). Size alone doesn't make such a trade trustworthy: the move has to be
 * one the trade could cause in a pool that holds a real share of the token (see poolShare).
 */

/** Below this a trade is dust: rounding dominates its implied price. */
export const MIN_PRICING_USD = 0.01;
/** A small trade this far from the reference price (either way) is treated as an outlier. */
export const MAX_DEVIATION = 3;
/** Trades at least this big may move the price further than MAX_DEVIATION (real pumps and dumps)... */
export const TRUSTED_USD = 50;
/** ...if the pool they imply holds at least this share of the market cap in liquidity. */
export const MIN_POOL_SHARE = 0.01;
/**
 * This many outliers in a row that agree with each other (across 2+ transactions, TRUSTED_USD+ between
 * them) re-anchor the price. A few cents of side-pool dust can't.
 */
export const REANCHOR_TRADES = 3;

export interface PriceCandidate {
  /** USD value of the trade (quote side). */
  usd: number;
  /** Implied USD price per token. */
  price: number;
  /** Quote amount in raw units (0 = nothing paid or received). */
  quoteRaw: bigint;
  /** Recent accepted price of the token, if any. */
  reference: number | null;
  /** Total supply in whole tokens, if known (market cap = reference x supply). */
  supply?: number | null;
}

/**
 * The pool liquidity, as a share of market cap, that a trade's price move implies.
 *
 * In a constant-product pool with quote reserve y (USD) at spot price p, a buy of Δy fills at an
 * average p·(1 + Δy/y), and a sell that receives Δy fills at p·(1 − Δy/y). So a fill at k·p
 * means y = Δy / |k − 1|, and y / marketCap is the pool's share. Concentrated liquidity only makes
 * y larger near the price (smaller moves), so a real pool never looks thinner than it is.
 */
export function poolShare(usd: number, price: number, reference: number, supply: number): number {
  const cap = reference * supply;
  const move = Math.abs(price / reference - 1);
  return cap > 0 && move > 0 ? usd / (move * cap) : Infinity;
}

/** Dust: rounding dominates, or nothing changed hands. Never prices, never counts as an outlier. */
function isDust(c: Pick<PriceCandidate, 'usd' | 'price' | 'quoteRaw'>): boolean {
  return !Number.isFinite(c.price) || c.price <= 0 || c.quoteRaw === 0n || !(c.usd >= MIN_PRICING_USD);
}

export function acceptsPrice(c: PriceCandidate): boolean {
  if (isDust(c)) return false;
  if (!c.reference || !(c.reference > 0)) return true;
  const ratio = c.price / c.reference;
  if (ratio <= MAX_DEVIATION && ratio >= 1 / MAX_DEVIATION) return true;
  if (c.usd < TRUSTED_USD) return false;
  // A big trade far from the reference: real only if it moved a pool that matters.
  return !c.supply || !(c.supply > 0) || poolShare(c.usd, c.price, c.reference, c.supply) >= MIN_POOL_SHARE;
}

/**
 * A token's running reference price: feed it the token's trades in chain order. Wraps acceptsPrice
 * so a wrong reference can't stick: when the market really has moved (or the reference itself was an
 * outlier), REANCHOR_TRADES outliers in a row that agree with each other, from 2+ transactions and
 * worth TRUSTED_USD together, become the new reference. A trade back near the reference resets the count, so an arbitrage
 * burst through side pools, interleaved with trades on the main pool, never re-anchors.
 */
export class PriceReference {
  private streak: { price: number; n: number; usd: number; txs: Set<string> } | null = null;

  constructor(public price: number | null = null) {}

  /** Whether this trade prices the token (and becomes the reference). */
  accept(c: Omit<PriceCandidate, 'reference'> & { tx: string }): boolean {
    if (isDust(c)) return false;
    if (acceptsPrice({ ...c, reference: this.price })) {
      this.price = c.price;
      this.streak = null;
      return true;
    }
    const s = this.streak;
    if (s && c.price / s.price <= MAX_DEVIATION && c.price / s.price >= 1 / MAX_DEVIATION) {
      s.n++;
      s.usd += c.usd;
      s.txs.add(c.tx);
    } else {
      this.streak = { price: c.price, n: 1, usd: c.usd, txs: new Set([c.tx]) };
    }
    const cur = this.streak!;
    if (cur.n >= REANCHOR_TRADES && cur.txs.size >= 2 && cur.usd >= TRUSTED_USD) {
      this.price = c.price;
      this.streak = null;
      return true;
    }
    return false;
  }
}

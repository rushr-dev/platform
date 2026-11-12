// PnL for one wallet and one token over a window, using "positions opened in the window" and
// average cost. Amounts are whole tokens (already divided by 10^decimals) and USD at trade time.

export interface PnlConfig {
  /** Unrealized gains count only when the token's liquidity is at least this. */
  minLiquidityForGainsUsd: number;
  /** Unrealized gains are capped at this share of the token's liquidity. */
  maxGainShareOfLiquidity: number;
}

export const DEFAULT_PNL_CONFIG: PnlConfig = { minLiquidityForGainsUsd: 10_000, maxGainShareOfLiquidity: 0.25 };

export interface Flows {
  boughtTokens: number;
  boughtUsd: number;
  soldTokens: number;
  soldUsd: number;
}

export interface TokenMarket {
  priceUsd: number | null;
  liquidityUsd: number | null;
}

export interface TokenPnl {
  realized: number;
  unrealized: number;
  pnl: number;
  remainingTokens: number;
  costBasisUsd: number;
}

export function tokenPnl(f: Flows, m: TokenMarket, cfg: PnlConfig = DEFAULT_PNL_CONFIG): TokenPnl {
  const zero = { realized: 0, unrealized: 0, pnl: 0, remainingTokens: 0, costBasisUsd: 0 };
  if (!(f.boughtTokens > 0) || !(f.boughtUsd >= 0)) return zero; // nothing bought in the window: sells of older bags don't count
  const avgCost = f.boughtUsd / f.boughtTokens;
  const matched = Math.min(Math.max(f.soldTokens, 0), f.boughtTokens);
  const realized = f.soldTokens > 0 ? (f.soldUsd * matched) / f.soldTokens - matched * avgCost : 0;
  const remaining = f.boughtTokens - matched;
  const cost = remaining * avgCost;
  let unrealized = 0;
  if (remaining > 0) {
    // A token with no price is valued at zero: an unpriced bag is a full loss until it trades again.
    const value = m.priceUsd !== null && Number.isFinite(m.priceUsd) ? remaining * m.priceUsd : 0;
    unrealized = value - cost;
    if (unrealized > 0) {
      const liq = m.liquidityUsd;
      if (liq === null || !Number.isFinite(liq) || liq < cfg.minLiquidityForGainsUsd) unrealized = 0;
      else unrealized = Math.min(unrealized, liq * cfg.maxGainShareOfLiquidity);
    }
  }
  return { realized, unrealized, pnl: realized + unrealized, remainingTokens: remaining, costBasisUsd: cost };
}

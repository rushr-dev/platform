import { erc20Abi, type Address, type PublicClient } from 'viem';
import type { TradeConfig } from './config';

/**
 * $RUSHR holder discount: the trading wallet's $RUSHR balance picks a tier (`cfg.holderTiers`), and the tier's
 * discount comes off the platform fee, stacked with any referral discount (`effectiveFeeBps`).
 */

/** Discount (bps of the fee) for a $RUSHR balance: the highest tier the balance reaches, else 0. */
export function holderDiscountBps(cfg: Pick<TradeConfig, 'holderTiers'>, balance: bigint): number {
  let best = 0;
  for (const t of cfg.holderTiers) if (balance >= t.min && t.discountBps > best) best = t.discountBps;
  return best;
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; bps: number }>();

/**
 * The trader's holder discount, read from the chain (one balanceOf), cached a minute per wallet so a
 * prebuilt trade or a re-quote costs nothing. A failed read gives no discount (and isn't cached), so a trade
 * never stalls on it: the trader pays at most the normal rate.
 */
export async function readHolderDiscountBps(client: PublicClient, trader: Address, cfg: Pick<TradeConfig, 'holderTiers' | 'rushrToken'>, now = Date.now()): Promise<number> {
  if (!cfg.holderTiers.length) return 0;
  const key = `${cfg.rushrToken}:${trader}`.toLowerCase();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.bps;
  try {
    const balance = await client.readContract({ address: cfg.rushrToken, abi: erc20Abi, functionName: 'balanceOf', args: [trader] });
    const bps = holderDiscountBps(cfg, balance);
    cache.set(key, { at: now, bps });
    return bps;
  } catch {
    return 0;
  }
}

/** Forget cached tiers (tests; or after the trader buys or sells $RUSHR, so the next quote sees the new tier). */
export function clearHolderCache(trader?: Address): void {
  if (!trader) return cache.clear();
  for (const k of [...cache.keys()]) if (k.endsWith(`:${trader.toLowerCase()}`)) cache.delete(k);
}

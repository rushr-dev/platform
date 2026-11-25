import { getAddress, isAddress, type Address } from 'viem';
import { TRADE_ADDRESSES } from './addresses';
import { TradeError } from './errors';

/**
 * Platform fee configuration.
 *
 * Treasury (decided 2026-11-12): currently a single EOA (no code on 4663), moving to a Safe. Known
 * risk (docs/trading.md): a single key. Mitigations: hardware-wallet key, regular sweeps, move to a Safe
 * before volume grows. Since 2026-11-16 the treasury is a Safe (`RUSHR_TREASURY`); the on-chain routers, once
 * deployed, can only move it through their guardian timelock (TreasuryTimelock), and this default must match.
 *
 * A real treasury no longer gates signing by itself: one-click (server-signed) trading is gated by
 * `assertOneClickAllowed` (RushrRouter deployed AND audited), the web UI by NEXT_PUBLIC_SWAP_ENABLED.
 */
export const RUSHR_TREASURY: Address = '0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3';

/**
 * Earlier fee treasuries, oldest first. Fees from trades built before a switch can still land here, so
 * fee audits and the transparency totals accept them too. The first one was a single EOA (2026-11-12 to 2026-11-16).
 */
export const LEGACY_TREASURIES: readonly Address[] = ['0x447a590b70cd55Cc6B62CEaf79D4c6c09A955E40'];

/** Kept for tests and forks: a config using it is refused by `assertSignable`. */
export const PLACEHOLDER_FEE_RECIPIENT: Address = '0x000000000000000000000000000000000000fee1';

/**
 * The platform fee (decided 2026-11-25): 1%, with 30% of it paid back to the trader as cashback (CASHBACK_SHARE_BPS).
 * It replaced the 0.25% beta rate and the earlier 0.5% standard (decided 2026-11-12, never switched on).
 */
export const STANDARD_FEE_BPS = 100;
/**
 * Split of every collected fee (decided 2026-11-25), in bps of the fee: 30% back to the trader as cashback, 20% buys
 * $RUSHR and burns it, the rest goes to the treasury. A referrer's share (`referrerShareBps`) comes out of the
 * treasury's part. The cashback accrues off-chain in the trade ledger and is paid weekly from the treasury Safe.
 */
export const CASHBACK_SHARE_BPS = 3_000;
export const BUYBACK_SHARE_BPS = 2_000;
/**
 * Beta rate (decided 2026-11-13): half price, 0.25%, on every route. Universal Router routes take it
 * inside the swap; PONS curve trades pay it as a follow-up transfer (curve-fee.ts).
 * To return to the standard rate, set `feeBps: STANDARD_FEE_BPS` in DEFAULT_TRADE_CONFIG below.
 */
export const BETA_FEE_BPS = 25;

/** $RUSHR, the platform's utility token (18 decimals). Holding it lowers the platform fee (`holderTiers`). */
export const RUSHR_TOKEN: Address = '0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed';

export interface HolderTier {
  /** Minimum $RUSHR held by the trading wallet, in wei (18 decimals). */
  min: bigint;
  /** Discount in bps OF THE FEE (1000 = 10% off), stacked with the referral discount. */
  discountBps: number;
}

const RUSHR = 10n ** 18n;
/**
 * $RUSHR holder discount (decided 2026-11-19): hold 1M for 10% off the platform fee, 10M for 25%, 50M for 50%.
 * Read from the trading wallet's balance at quote time; stacks with the referral discount. Highest tier first.
 */
export const HOLDER_TIERS: readonly HolderTier[] = [
  { min: 50_000_000n * RUSHR, discountBps: 5_000 },
  { min: 10_000_000n * RUSHR, discountBps: 2_500 },
  { min: 1_000_000n * RUSHR, discountBps: 1_000 },
];

/** Hard cap so a bad config can never take more than 3% of a trade. */
export const MAX_FEE_BPS = 300;

export interface TradeConfig {
  /** Platform fee in basis points of the quote-side amount (25 = 0.25%). Beta: BETA_FEE_BPS; standard: STANDARD_FEE_BPS. */
  feeBps: number;
  /** Referee discount, in bps OF THE FEE (1000 = 10% off). Rounded in the referee's favour
   *  (`effectiveFeeBps`): 0.5% becomes 0.45%, the 0.25% beta rate becomes 0.22%. */
  referralDiscountBps: number;
  /** Referrer's share of the fee actually collected, in bps of the fee (2000 = 20%). Accounted off-chain. */
  referrerShareBps: number;
  /** Trader's cashback: share of the fee they actually paid, in bps of the fee (3000 = 30%). Accounted off-chain, paid weekly. */
  cashbackShareBps: number;
  /** $RUSHR holder discount tiers, highest first (`holderDiscountBps`). Empty: no holder discount. */
  holderTiers: readonly HolderTier[];
  /** Token whose balance sets the holder tier. */
  rushrToken: Address;
  /** Treasury that receives the fee. */
  feeRecipient: Address;
  /** Universal Router used for Uniswap v2/v3/v4 routes. */
  universalRouter: Address;
  /** Deployed RushrPonsRouter for PONS curves; null until deployed (curve routes are then unsupported). */
  ponsRouter: Address | null;
  /** Deployed RushrRouter (structured Uniswap routes, output only to the trader); null until deployed. */
  rushrRouter: Address | null;
  /** Set true only after RushrRouter's independent audit. Gates one-click (server-signed) trading. */
  rushrRouterAudited: boolean;
  /** Default slippage in bps (on top of measured token tax). */
  defaultSlippageBps: number;
  /** Deadline for router txs, seconds from build time. */
  deadlineSeconds: number;
}

export const DEFAULT_TRADE_CONFIG: TradeConfig = {
  feeBps: STANDARD_FEE_BPS,
  referralDiscountBps: 1_000,
  referrerShareBps: 2_000,
  cashbackShareBps: CASHBACK_SHARE_BPS,
  holderTiers: HOLDER_TIERS,
  rushrToken: RUSHR_TOKEN,
  feeRecipient: RUSHR_TREASURY,
  universalRouter: TRADE_ADDRESSES.universalRouter,
  ponsRouter: null,
  rushrRouter: null,
  rushrRouterAudited: false,
  defaultSlippageBps: 100,
  deadlineSeconds: 300,
};

export function resolveConfig(partial: Partial<TradeConfig> = {}): TradeConfig {
  const cfg = { ...DEFAULT_TRADE_CONFIG, ...partial };
  if (!Number.isInteger(cfg.feeBps) || cfg.feeBps < 0 || cfg.feeBps > MAX_FEE_BPS)
    throw new TradeError('CONFIG_INVALID', `feeBps must be an integer between 0 and ${MAX_FEE_BPS}`, { feeBps: cfg.feeBps });
  if (!isAddress(cfg.feeRecipient, { strict: false }) || BigInt(cfg.feeRecipient) < 0x10n)
    throw new TradeError('CONFIG_INVALID', 'feeRecipient must be a real address', { feeRecipient: cfg.feeRecipient });
  for (const k of ['referralDiscountBps', 'referrerShareBps'] as const)
    if (!Number.isInteger(cfg[k]) || cfg[k] < 0 || cfg[k] > 10_000) throw new TradeError('CONFIG_INVALID', `${k} must be an integer between 0 and 10000`);
  for (const t of cfg.holderTiers)
    if (t.min < 0n || !Number.isInteger(t.discountBps) || t.discountBps < 0 || t.discountBps > 10_000) throw new TradeError('CONFIG_INVALID', 'holderTiers: min >= 0 and discountBps 0..10000');
  if (!Number.isInteger(cfg.defaultSlippageBps) || cfg.defaultSlippageBps < 0 || cfg.defaultSlippageBps > 5000)
    throw new TradeError('CONFIG_INVALID', 'defaultSlippageBps must be 0..5000');
  return { ...cfg, feeRecipient: getAddress(cfg.feeRecipient) };
}

export function isPlaceholderRecipient(cfg: TradeConfig): boolean {
  return cfg.feeRecipient.toLowerCase() === PLACEHOLDER_FEE_RECIPIENT.toLowerCase();
}

/** Call before giving a built tx to a wallet. Simulation does not need this. */
export function assertSignable(cfg: TradeConfig): void {
  if (isPlaceholderRecipient(cfg))
    throw new TradeError('FEE_RECIPIENT_PLACEHOLDER', 'The fee treasury is still a placeholder; trading is disabled until it is configured');
}

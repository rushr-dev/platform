import { getAddress, isAddress, type Address } from 'viem';
import { TRADE_ADDRESSES } from './addresses';
import { TradeError } from './errors';

/**
 * Platform fee configuration. PLACEHOLDER VALUES: the founder sets the real treasury (a multisig) and
 * rate. While the recipient is the placeholder, quotes and simulations work but `assertSignable`
 * refuses to hand a transaction to a wallet.
 */
export const PLACEHOLDER_FEE_RECIPIENT: Address = '0x000000000000000000000000000000000000fee1';

/** Hard cap so a bad config can never take more than 3% of a trade. */
export const MAX_FEE_BPS = 300;

export interface TradeConfig {
  /** Platform fee in basis points of the quote-side amount (100 = 1%). */
  feeBps: number;
  /** Treasury that receives the fee. */
  feeRecipient: Address;
  /** Universal Router used for Uniswap v2/v3/v4 routes. */
  universalRouter: Address;
  /** Deployed RushrCurveRouter for PONS curves; null until deployed (curve routes are then unsupported). */
  curveRouter: Address | null;
  /** Default slippage in bps (on top of measured token tax). */
  defaultSlippageBps: number;
  /** Deadline for router txs, seconds from build time. */
  deadlineSeconds: number;
}

export const DEFAULT_TRADE_CONFIG: TradeConfig = {
  feeBps: 100,
  feeRecipient: PLACEHOLDER_FEE_RECIPIENT,
  universalRouter: TRADE_ADDRESSES.universalRouter,
  curveRouter: null,
  defaultSlippageBps: 100,
  deadlineSeconds: 300,
};

export function resolveConfig(partial: Partial<TradeConfig> = {}): TradeConfig {
  const cfg = { ...DEFAULT_TRADE_CONFIG, ...partial };
  if (!Number.isInteger(cfg.feeBps) || cfg.feeBps < 0 || cfg.feeBps > MAX_FEE_BPS)
    throw new TradeError('CONFIG_INVALID', `feeBps must be an integer between 0 and ${MAX_FEE_BPS}`, { feeBps: cfg.feeBps });
  if (!isAddress(cfg.feeRecipient, { strict: false }) || BigInt(cfg.feeRecipient) < 0x10n)
    throw new TradeError('CONFIG_INVALID', 'feeRecipient must be a real address', { feeRecipient: cfg.feeRecipient });
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

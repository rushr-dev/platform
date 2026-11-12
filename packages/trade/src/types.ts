import type { Address, Hex } from 'viem';
import type { FeeBreakdown, Side } from './fees';
import type { EncodedCommand, PoolKey } from './universal-router';

export type Venue = 'uniswap-v4' | 'uniswap-v3' | 'uniswap-v2' | 'pons-curve';

/** What the user pays with (buys) or receives (sells). ETH routes through native-ETH or WETH pools. */
export type QuoteAsset = 'ETH' | 'USDG';

export interface PoolBase {
  venue: Venue;
  /** v4 pool id, v3/v2 pool address or PONS curve address. */
  id: Hex;
  token: Address;
  /** Pool-side quote currency: native ETH (0x0, v4 only), WETH or USDG. */
  quote: Address;
  /** Venue's own fee in bps, for disclosure. */
  venueFeeBps: number;
  venueFeeLabel: string;
}

export interface V4Pool extends PoolBase {
  venue: 'uniswap-v4';
  key: PoolKey;
  hookData: Hex;
  launchpad?: string | null;
}
export interface V3Pool extends PoolBase {
  venue: 'uniswap-v3';
  fee: number;
}
export interface V2Pool extends PoolBase {
  venue: 'uniswap-v2';
  reserveToken: bigint;
  reserveQuote: bigint;
}
export interface PonsPool extends PoolBase {
  venue: 'pons-curve';
  curve: Address;
  quoteReserve: bigint;
  tokenReserve: bigint;
  feeBps: number;
  creatorTaxBps: number;
  /** Snipe tax at quote time (bps); non-zero only in the first seconds after launch. */
  snipeTaxBps: number;
  graduated: boolean;
}
export type Pool = V4Pool | V3Pool | V2Pool | PonsPool;

export interface SwapRequest {
  side: Side;
  token: Address;
  quoteAsset: QuoteAsset;
  /** Buys: quote-asset amount the user spends (fee included). Sells: token amount sold. */
  amountIn: bigint;
  /** The wallet that signs; also the recipient. */
  trader: Address;
  slippageBps?: number;
}

export interface Quote {
  request: SwapRequest;
  pool: Pool;
  /** Total the user spends. */
  amountIn: bigint;
  /** What actually goes into the venue (buys: amountIn minus our fee). */
  swapAmountIn: bigint;
  /** Venue output before our fee (sells) / equals amountOut on buys. */
  grossOut: bigint;
  /** Expected amount the user receives. */
  amountOut: bigint;
  /** Minimum the user receives (slippage applied), enforced on-chain. */
  minAmountOut: bigint;
  /** Sells: minimum gross venue output consistent with minAmountOut. */
  minGrossOut: bigint;
  slippageBps: number;
  fee: FeeBreakdown;
  priceImpactBps: number | null;
  gasEstimate: bigint | null;
  warnings: string[];
}

export interface Approval {
  /** 'erc20' = token.approve(spender); 'permit2' = Permit2.approve(token, spender, amount, expiration) or a PermitSingle signature. */
  kind: 'erc20' | 'permit2';
  token: Address;
  spender: Address;
  amount: bigint;
  /** Current allowance, when known. */
  current?: bigint;
}

export interface BuiltSwap {
  quote: Quote;
  tx: { to: Address; data: Hex; value: bigint };
  /** Steps the wallet must complete before `tx` (in order). */
  approvals: Approval[];
  /** Universal Router commands, for the route disclosure and tests (empty for the curve router). */
  commands: EncodedCommand[];
  deadline: bigint;
}

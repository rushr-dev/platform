import { zeroAddress, type Address, type PublicClient } from 'viem';
import { TRADE_ADDRESSES } from './addresses.ts';
import { v3PoolAbi, v3QuoterV2Abi, v4QuoterAbi, v4StateViewAbi } from './abis.ts';
import type { TradeConfig } from './config.ts';
import { TradeError, revertDataOf, sanitizeRpcMessage } from './errors.ts';
import { decodeRevert } from './revert.ts';
import { minOut, priceImpactBps, sellMinimums, splitBuyInput, splitSellOutput, type FeeBreakdown } from './fees.ts';
import { ponsBuyOut, ponsSellOut, ponsSpotBuyOut, v2AmountOut, v2SpotOut } from './math.ts';
import { discoverPools, type DiscoverOptions } from './pools.ts';
import type { Pool, Quote, SwapRequest } from './types.ts';

const Q192 = 1n << 192n;

/** Spot output at sqrtPriceX96 (token1 per token0 = sqrtP^2 / 2^192), excluding fees. */
export function spotOutFromSqrtPrice(amountIn: bigint, sqrtPriceX96: bigint, zeroForOne: boolean): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  return zeroForOne ? (amountIn * p2) / Q192 : (amountIn * Q192) / p2;
}

/** The currency that enters the pool on this trade (WETH when the user pays ETH into a WETH pool). */
export function venueCurrencies(pool: Pool, side: SwapRequest['side']): { tokenIn: Address; tokenOut: Address } {
  return side === 'buy' ? { tokenIn: pool.quote, tokenOut: pool.token } : { tokenIn: pool.token, tokenOut: pool.quote };
}

/** The asset our fee is paid in: the user-facing quote asset (ETH for native/WETH pools, USDG otherwise). */
export function feeTokenFor(pool: Pool): Address {
  return pool.quote === TRADE_ADDRESSES.usdg ? TRADE_ADDRESSES.usdg : TRADE_ADDRESSES.eth;
}

interface VenueQuote {
  out: bigint;
  spotOut: bigint | null;
  gas: bigint | null;
}

/** Raw venue output for `amountIn` (no Rushr fee). One or two eth_calls for v3/v4, none for v2/PONS. */
export async function quoteVenue(client: PublicClient, pool: Pool, side: SwapRequest['side'], amountIn: bigint): Promise<VenueQuote> {
  const { tokenIn, tokenOut } = venueCurrencies(pool, side);
  try {
    switch (pool.venue) {
      case 'uniswap-v2': {
        const [rIn, rOut] = side === 'buy' ? [pool.reserveQuote, pool.reserveToken] : [pool.reserveToken, pool.reserveQuote];
        return { out: v2AmountOut(amountIn, rIn, rOut), spotOut: v2SpotOut(amountIn, rIn, rOut), gas: null };
      }
      case 'pons-curve': {
        if (pool.graduated) throw new TradeError('CURVE_GRADUATED', 'This PONS token has graduated; trade it on its Uniswap v4 pool');
        if (side === 'buy')
          return { out: ponsBuyOut(amountIn, pool.quoteReserve, pool.tokenReserve, pool.feeBps, pool.creatorTaxBps), spotOut: ponsSpotBuyOut(amountIn, pool.quoteReserve, pool.tokenReserve), gas: null };
        return {
          out: ponsSellOut(amountIn, pool.quoteReserve, pool.tokenReserve, pool.feeBps, pool.creatorTaxBps),
          spotOut: pool.tokenReserve > 0n ? (amountIn * pool.quoteReserve) / pool.tokenReserve : null,
          gas: null,
        };
      }
      case 'uniswap-v3': {
        const [{ result }, slot0] = await Promise.all([
          client.simulateContract({
            address: TRADE_ADDRESSES.v3.quoterV2,
            abi: v3QuoterV2Abi,
            functionName: 'quoteExactInputSingle',
            args: [{ tokenIn, tokenOut, amountIn, fee: pool.fee, sqrtPriceLimitX96: 0n }],
          }),
          client.readContract({ address: pool.id as Address, abi: v3PoolAbi, functionName: 'slot0' }).catch(() => null),
        ]);
        const zeroForOne = BigInt(tokenIn) < BigInt(tokenOut);
        return { out: result[0], spotOut: slot0 ? spotOutFromSqrtPrice(amountIn, slot0[0], zeroForOne) : null, gas: result[3] };
      }
      case 'uniswap-v4': {
        const zeroForOne = pool.key.currency0 === tokenIn;
        const [{ result }, slot0] = await Promise.all([
          client.simulateContract({
            address: TRADE_ADDRESSES.v4.quoter,
            abi: v4QuoterAbi,
            functionName: 'quoteExactInputSingle',
            args: [{ poolKey: pool.key, zeroForOne, exactAmount: amountIn, hookData: pool.hookData }],
          }),
          client.readContract({ address: TRADE_ADDRESSES.v4.stateView, abi: v4StateViewAbi, functionName: 'getSlot0', args: [pool.id] }).catch(() => null),
        ]);
        return { out: result[0], spotOut: slot0 ? spotOutFromSqrtPrice(amountIn, slot0[0], zeroForOne) : null, gas: result[1] };
      }
    }
  } catch (e) {
    if (e instanceof TradeError) throw e;
    const data = revertDataOf(e);
    const msg = data ? decodeRevert(data) : sanitizeRpcMessage(e);
    const code = /NotEnoughLiquidity|SPL|LOK/.test(msg) ? 'INSUFFICIENT_LIQUIDITY' : 'QUOTE_FAILED';
    throw new TradeError(code, `${pool.venue} quote failed: ${msg}`, { pool: pool.id });
  }
}

/** Full quote for one pool: Rushr fee, venue output, slippage minimums and warnings. */
export async function quotePool(client: PublicClient, pool: Pool, req: SwapRequest, cfg: TradeConfig): Promise<Quote> {
  if (req.amountIn <= 0n) throw new TradeError('INVALID_AMOUNT', 'amount must be > 0');
  const slippageBps = req.slippageBps ?? cfg.defaultSlippageBps;
  const warnings: string[] = [];
  const feeToken = feeTokenFor(pool);
  const fee = (amount: bigint): FeeBreakdown => ({
    side: req.side,
    feeToken,
    feeBps: cfg.feeBps,
    feeAmount: amount,
    venueFeeBps: pool.venueFeeBps,
    venueFeeLabel: pool.venueFeeLabel,
  });

  if (pool.venue === 'pons-curve') {
    if (pool.snipeTaxBps > 0) warnings.push(`PONS snipe tax active: ${(pool.snipeTaxBps / 100).toFixed(1)}% right now (decays to 0 in the first seconds after launch)`);
    if (!cfg.curveRouter) warnings.push('PONS curve trades need the Rushr curve router, which is not deployed yet');
  }
  if (pool.venue === 'uniswap-v4' && pool.key.hooks !== zeroAddress) warnings.push('Hooked v4 pool: the hook may change fees or behaviour at swap time');

  if (req.side === 'buy') {
    const { fee: feeAmount, swapAmount } = splitBuyInput(req.amountIn, cfg.feeBps);
    const v = await quoteVenue(client, pool, 'buy', swapAmount);
    if (v.out === 0n) throw new TradeError('INSUFFICIENT_LIQUIDITY', 'Quote returned zero output', { pool: pool.id });
    const impact = v.spotOut ? Math.max(0, priceImpactBps(v.spotOut, v.out) - pool.venueFeeBps) : null;
    if (impact !== null && impact > 500) warnings.push(`High price impact: ${(impact / 100).toFixed(1)}%`);
    return {
      request: req,
      pool,
      amountIn: req.amountIn,
      swapAmountIn: swapAmount,
      grossOut: v.out,
      amountOut: v.out,
      minAmountOut: minOut(v.out, slippageBps),
      minGrossOut: minOut(v.out, slippageBps),
      slippageBps,
      fee: fee(feeAmount),
      priceImpactBps: impact,
      gasEstimate: v.gas,
      warnings,
    };
  }

  const v = await quoteVenue(client, pool, 'sell', req.amountIn);
  if (v.out === 0n) throw new TradeError('INSUFFICIENT_LIQUIDITY', 'Quote returned zero output', { pool: pool.id });
  const { fee: feeAmount, netOut } = splitSellOutput(v.out, cfg.feeBps);
  const { minGross, minNet } = sellMinimums(v.out, cfg.feeBps, slippageBps);
  const impact = v.spotOut ? Math.max(0, priceImpactBps(v.spotOut, v.out) - pool.venueFeeBps) : null;
  if (impact !== null && impact > 500) warnings.push(`High price impact: ${(impact / 100).toFixed(1)}%`);
  return {
    request: req,
    pool,
    amountIn: req.amountIn,
    swapAmountIn: req.amountIn,
    grossOut: v.out,
    amountOut: netOut,
    minAmountOut: minNet,
    minGrossOut: minGross,
    slippageBps,
    fee: fee(feeAmount),
    priceImpactBps: impact,
    gasEstimate: v.gas,
    warnings,
  };
}

export interface RouteResult {
  best: Quote;
  /** All successful quotes, best first. */
  quotes: Quote[];
  /** Pools that failed to quote, with the reason. */
  failures: { pool: Pool; error: TradeError }[];
}

/** Ranks quotes: highest amount the user receives wins. */
export function rankQuotes(quotes: Quote[]): Quote[] {
  return [...quotes].sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
}

/** Discover pools, quote them all and pick the best single-pool route. */
export async function findBestRoute(client: PublicClient, req: SwapRequest, cfg: TradeConfig, discover: Omit<DiscoverOptions, 'quoteAsset'> = {}): Promise<RouteResult> {
  if (req.token.toLowerCase() === TRADE_ADDRESSES.weth || req.token.toLowerCase() === TRADE_ADDRESSES.usdg || req.token === zeroAddress)
    throw new TradeError('SAME_TOKEN', 'Pick a token other than the quote asset');
  const pools = await discoverPools(client, req.token, { ...discover, quoteAsset: req.quoteAsset, trader: req.trader });
  const tradable = pools.filter((p) => !(p.venue === 'pons-curve' && p.graduated));
  if (!tradable.length) throw new TradeError('NO_ROUTE', 'No pool found for this token and quote asset', { token: req.token });
  const settled = await Promise.allSettled(tradable.map((p) => quotePool(client, p, req, cfg)));
  const quotes: Quote[] = [];
  const failures: RouteResult['failures'] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') quotes.push(s.value);
    else failures.push({ pool: tradable[i]!, error: s.reason instanceof TradeError ? s.reason : new TradeError('QUOTE_FAILED', sanitizeRpcMessage(s.reason)) });
  });
  if (!quotes.length) throw new TradeError('NO_ROUTE', 'Every pool failed to quote', { failures: failures.map((f) => `${f.pool.venue}: ${f.error.message}`) });
  const ranked = rankQuotes(quotes);
  // Prefer a route we can actually build (PONS curves need the fee router deployed).
  const best = ranked.find((q) => isBuildable(q.pool, cfg)) ?? ranked[0]!;
  return { best, quotes: ranked, failures };
}

export function isBuildable(pool: Pool, cfg: TradeConfig): boolean {
  return pool.venue !== 'pons-curve' || cfg.curveRouter !== null;
}

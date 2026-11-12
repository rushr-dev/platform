import { encodeFunctionData, keccak256, encodeAbiParameters, maxUint256, parseAbi, zeroAddress, type Address, type Hex } from 'viem';
import { TRADE_ADDRESSES } from './addresses';
import type { TradeConfig } from './config';
import { TradeError } from './errors';
import { v4PoolId } from './math';
import type { BuiltSwap, Pool, Quote } from './types';

/**
 * RushrRouter (contracts/src/RushrRouter.sol, NOT DEPLOYED, audit-gated): structured Uniswap routes,
 * output only to msg.sender. This is the only Uniswap entry point a one-click server signer may call.
 */
export const rushrRouterAbi = parseAbi([
  'struct Route { uint8 kind; address token; address quote; uint24 fee; int24 tickSpacing; address hooks; }',
  'function buy(Route route, uint256 minTokensOut, uint256 deadline, bool referred) payable returns (uint256)',
  'function sell(Route route, uint256 tokensIn, uint256 minQuoteOut, uint256 deadline, bool referred) returns (uint256)',
  'function sellAnyPool(Route route, uint256 tokensIn, uint256 minQuoteOut, uint256 deadline, bool referred) returns (uint256)',
  'function poolKeyOf(Route route) view returns (bytes32)',
  'function sellPoolAllowed(bytes32) view returns (bool)',
  'function hookAllowed(address) view returns (bool)',
  'function paused() view returns (bool)',
]);

export const RouteKind = { V2: 0, V3: 1, V4: 2 } as const;

export interface RushrRoute {
  kind: number;
  token: Address;
  quote: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** Route struct for a pool, or null when RushrRouter can't trade it (USDG pools, PONS curves). */
export function routeFromPool(pool: Pool): RushrRoute | null {
  switch (pool.venue) {
    case 'uniswap-v2':
      return pool.quote === TRADE_ADDRESSES.weth ? { kind: RouteKind.V2, token: pool.token, quote: pool.quote, fee: 0, tickSpacing: 0, hooks: zeroAddress } : null;
    case 'uniswap-v3':
      return pool.quote === TRADE_ADDRESSES.weth ? { kind: RouteKind.V3, token: pool.token, quote: pool.quote, fee: pool.fee, tickSpacing: 0, hooks: zeroAddress } : null;
    case 'uniswap-v4':
      return pool.quote === TRADE_ADDRESSES.eth || pool.quote === TRADE_ADDRESSES.weth
        ? { kind: RouteKind.V4, token: pool.token, quote: pool.quote, fee: pool.key.fee, tickSpacing: pool.key.tickSpacing, hooks: pool.key.hooks }
        : null;
    default:
      return null;
  }
}

/** Same key as RushrRouter.poolKeyOf (sell allowlist): the v4 PoolId, or a hash of the canonical v2/v3 pool. */
export function rushrPoolKey(r: RushrRoute): Hex {
  const [a, b] = BigInt(r.quote) < BigInt(r.token) ? [r.quote, r.token] : [r.token, r.quote];
  if (r.kind === RouteKind.V4) return v4PoolId({ currency0: a, currency1: b, fee: r.fee, tickSpacing: r.tickSpacing, hooks: r.hooks });
  return keccak256(
    encodeAbiParameters([{ type: 'uint8' }, { type: 'address' }, { type: 'address' }, { type: 'uint24' }], [r.kind, a, b, r.kind === RouteKind.V3 ? r.fee : 0]),
  );
}

export interface RushrRouterBuildOptions {
  deadline?: bigint;
  now?: number;
  /** Sells: 'allowlisted' (`sell`, the only sell the server signer may call) or 'any' (`sellAnyPool`,
   *  user-confirmed). Default 'allowlisted'. */
  sellMode?: 'allowlisted' | 'any';
}

/** Unsigned RushrRouter tx for a quote (ETH-quoted Uniswap pools). */
export function buildRushrRouterSwap(q: Quote, cfg: TradeConfig, opts: RushrRouterBuildOptions = {}): BuiltSwap {
  if (!cfg.rushrRouter) throw new TradeError('UNSUPPORTED_VENUE', 'RushrRouter is not deployed yet');
  const route = routeFromPool(q.pool);
  if (!route) throw new TradeError('UNSUPPORTED_VENUE', `RushrRouter can't trade ${q.pool.venue} pools quoted in ${q.request.quoteAsset}`);
  const now = BigInt(opts.now ?? Math.floor(Date.now() / 1000));
  const deadline = opts.deadline ?? now + BigInt(cfg.deadlineSeconds);
  const referred = q.fee.feeBps < q.fee.baseFeeBps;
  const router = cfg.rushrRouter;
  if (q.request.side === 'buy')
    return {
      quote: q,
      tx: { to: router, value: q.amountIn, data: encodeFunctionData({ abi: rushrRouterAbi, functionName: 'buy', args: [route, q.minAmountOut, deadline, referred] }) },
      approvals: [],
      commands: [],
      deadline,
    };
  const fn = opts.sellMode === 'any' ? 'sellAnyPool' : 'sell';
  return {
    quote: q,
    tx: { to: router, value: 0n, data: encodeFunctionData({ abi: rushrRouterAbi, functionName: fn, args: [route, q.amountIn, q.minAmountOut, deadline, referred] }) },
    approvals: [{ kind: 'erc20', token: q.pool.token, spender: router, amount: maxUint256 }],
    commands: [],
    deadline,
  };
}

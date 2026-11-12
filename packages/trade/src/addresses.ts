import type { Address } from 'viem';
import { QUOTES, UNISWAP, NATIVE_ETH } from '@rushr/core/chain/robinhood';

/**
 * Trading contracts on Robinhood Chain (4663). Uniswap entries come from Uniswap's official deployment
 * list (developers.uniswap.org/deployments.json, 2026-11-04) and were checked on-chain on 2026-11-12.
 * Both Universal Routers embed only the FIRST v3 and v2 factory below (verified in bytecode), so pools
 * of other factories/forks cannot be routed through them.
 */
export const TRADE_ADDRESSES = {
  chainId: 4663,
  eth: NATIVE_ETH,
  weth: QUOTES.WETH,
  usdg: QUOTES.USDG,
  permit2: UNISWAP.permit2,
  /** Universal Router v2.1.2, Uniswap's official deployment for 4663. */
  universalRouter: '0x204faca1764b154221e35c0d20abb3c525710498',
  /** Older Universal Router in the core registry; same factories embedded, busier on-chain. */
  universalRouterLegacy: UNISWAP.v4.universalRouter,
  v4: {
    poolManager: UNISWAP.v4.poolManager,
    positionManager: UNISWAP.v4.positionManager,
    quoter: UNISWAP.v4.quoter,
    stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  },
  v3: {
    factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa',
    quoterV2: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7',
  },
  v2: {
    factory: '0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f',
    router02: '0x89e5db8b5aa49aa85ac63f691524311aeb649eba',
  },
  pons: {
    /** PONS launch factory: getLaunchedToken(token) -> (token, curve, creator, ...). */
    factory: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  },
} as const satisfies Record<string, unknown>;

export const UR_MSG_SENDER: Address = '0x0000000000000000000000000000000000000001';
export const UR_ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002';

/** Standard Uniswap v3 fee tiers on this chain's factory. */
export const V3_FEE_TIERS = [100, 500, 3000, 10000] as const;
/** Hookless v4 pools commonly use these (fee, tickSpacing) pairs. */
export const V4_STANDARD_POOLS = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
] as const;

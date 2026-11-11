import { parseAbi, type Address, type Hex } from 'viem';

/**
 * Robinhood Chain contract registry for the indexer.
 * Every entry was confirmed on-chain on 2026-11-11 — see docs/chain-recon.md for decoded examples.
 * Addresses are lowercase.
 */

export const ROBINHOOD_CHAIN = {
  id: 4663,
  name: 'Robinhood Chain',
  nativeSymbol: 'ETH',
  publicRpc: 'https://rpc.mainnet.chain.robinhood.com',
  explorer: 'https://robinhoodchain.blockscout.com',
  /** Measured average over 10,000 blocks. Arbitrum Orbit (Nitro). */
  blockTimeSeconds: 0.11,
  /** Nitro L2 blocks don't reorg in practice before L1 posting; keep a small safety margin. */
  confirmations: 20,
} as const;

export const NATIVE_ETH: Address = '0x0000000000000000000000000000000000000000';

export const QUOTES = {
  WETH: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // Global Dollar, 6 decimals
} as const satisfies Record<string, Address>;

/** Quotes we price memecoins against. Doppler also pairs agent coins with tokenized stocks (see STOCK_QUOTES). */
export const PRICE_QUOTES: Address[] = [NATIVE_ETH, QUOTES.WETH, QUOTES.USDG];

/** Robinhood stock tokens seen as Doppler numeraires. Not exhaustive: the indexer should treat
 *  any token emitting TransferWithScaledUI as a stock token. */
export const STOCK_QUOTES = {
  SPCX: '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea',
  TTWO: '0x5e81213613b6b86eab4c6c50d718d34359459786',
  NVDA: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec',
} as const satisfies Record<string, Address>;

/** Most active native-ETH/USDG v4 pools (currency0 = ETH). Swaps here give the on-chain ETH/USD price. */
export const ETH_USD_REFERENCE_POOLS: Hex[] = [
  '0xa791e5169faf703c0b63fd9552c33ec1128a773a00f5dc33a640da62a022cd35', // dynamic fee, ~1,000 swaps/h
  '0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e', // 0.01%
  '0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982', // 0.05%
];

export const UNISWAP = {
  v4: {
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
    universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
    quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  },
  v3: {
    factories: ['0x1f7d7550b1b028f7571e69a784071f0205fd2efa', '0xe7fef2bc860b25bbdeb6f6ab96d88baaa77ddad7'],
  },
  v2: {
    factories: ['0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f', '0x0d1ebb179cdbca88d74c923c4255cb2b17474afd'],
  },
  permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
} as const;

export const ABIS = {
  erc20: parseAbi([
    'event Transfer(address indexed from, address indexed to, uint256 value)',
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
  ]),
  v4PoolManager: parseAbi([
    'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
    'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
    'event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)',
  ]),
  v3: parseAbi([
    'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
    'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  ]),
  v2: parseAbi([
    'event PairCreated(address indexed token0, address indexed token1, address pair, uint256)',
    'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
    'event Sync(uint112 reserve0, uint112 reserve1)',
  ]),
  dopplerAirlock: parseAbi([
    'event Create(address asset, address indexed numeraire, address initializer, address poolOrHook)',
    'event Migrate(address indexed asset, address indexed pool)',
  ]),
} as const;

/** Event topics for launchpads without public ABIs (decoded by layout, see docs/chain-recon.md). */
export const TOPICS = {
  /** lift.fun launch. topics: [sig, token, creator, poolId]; data: quote, ..., name, symbol, metadataUri */
  liftLaunch: '0x6f0c466814ca3040318951d80aafb489060ae72ecdfc7cd1d5678ca5d8038c0e',
  /** lift.fun creator's initial buy, same tx as launch. topics: [sig, token, creator]; data: ethIn, tokensOut */
  liftDevBuy: '0x34b6bd41bb4087aa5e8294323c3f441554c538e0b5107fc056bd9ce45654083d',
  /** PONS launch. topics: [sig, token, curve, creator?]; data: creator?, ethIn (dev buy), tokensOut */
  ponsLaunch: '0xdcacba5e347ae7abd91cb519eb877af8fa7774e347b85dd3ddcd24a2ba8cdf37',
  /** PONS curve buy (emitted by the per-token curve). topics: [sig, buyer, recipient]; data: ethIn, tokensOut, fee, fee */
  ponsBuy: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',
  /** PONS curve sell. topics: [sig, seller, recipient]; data: tokensIn, ethOut, fee, fee */
  ponsSell: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',
  /** PONS curve graduation (emitted by the curve). data: [ponsMigrator, ethRaised, tokensMigrated]. Liquidity moves to a v4 pool with the PONS v2 hook in the same tx. */
  ponsGraduate: '0xf8d37a90738ae063b8b8058b66f5880cf3cf7ab0c5d4fa78219696591dfbfb67',
  /** Robinhood stock tokens emit this alongside Transfer. */
  transferWithScaledUI: '0x37e7f0db430edc9dd31bc66f25f8449353aa0818f503b906747dd8f286cd3802',
} as const satisfies Record<string, Hex>;

export type LaunchpadId = 'doppler' | 'liftfun' | 'pons' | 'vorta' | 'uniswap-v4' | 'uniswap-v3' | 'uniswap-v2';

export interface Launchpad {
  id: LaunchpadId;
  name: string;
  /** Contract users call to launch. */
  launcher?: Address;
  /** Uniswap v4 hook address on launched pools (identifies the launchpad from Initialize alone). */
  hooks?: Address[];
  /** Approx. launches per 12h when recorded (2026-11-11), for prioritising. */
  launchesPer12h: number;
  /** How trades are observed. */
  trades: 'v4-swap' | 'pons-curve';
  notes: string;
}

export const LAUNCHPADS: Launchpad[] = [
  {
    id: 'doppler',
    name: 'Doppler (Orbofi and other frontends)',
    launcher: '0xeb7c034704ef8dcd2d32324c1545f62fb4ad0862', // Airlock; calls arrive via proxy 0x1eef016f…
    hooks: ['0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544'], // DopplerHookInitializer
    launchesPer12h: 251,
    trades: 'v4-swap',
    notes:
      'Airlock emits Create(asset, numeraire, initializer, poolOrHook) and Migrate on graduation. Numeraire can be WETH, USDG or a stock token. Liquidity is a ladder of v4 positions (curve).',
  },
  {
    id: 'pons',
    name: 'PONS',
    launcher: '0xe33e9e479df8802cb0866d5d05258bec4cf62948',
    // PONS v2 hook: graduated tokens trade in a v4 pool with this hook (curve graduates at ~4.2 ETH).
    hooks: ['0xe5e702641ea86f4ae6cc3cdaed2b886f976be044'],
    launchesPer12h: 215,
    trades: 'pons-curve',
    notes:
      'Each token gets its own curve contract (ponsLaunch topic[2]); trades are ponsBuy/ponsSell from that curve. At ~4.2 ETH the curve emits ponsGraduate and liquidity moves to a v4 pool with the PONS v2 hook (migrator 0x7ed598bc…).',
  },
  {
    id: 'liftfun',
    name: 'lift.fun',
    launcher: '0xc739229dc490ee67f3472604f4addd57178489c6',
    hooks: ['0x2c668601193e4a081dd82604785e436aff6a2acc'],
    launchesPer12h: 84,
    trades: 'v4-swap',
    notes: 'Paired with WETH. Launch event carries name, symbol and metadata URI (api.lift.fun).',
  },
  {
    id: 'vorta',
    name: 'Vorta (single deployer bot)',
    launcher: '0xa24bcd15e71d46ea8c14adcad6eb2232f041105a',
    hooks: ['0x177dff3c65266de4f22e57221944154628be28c4'],
    launchesPer12h: 73,
    trades: 'v4-swap',
    notes: 'All launches from one deployer (0xd0f555a7…). Likely spam; flag as serial launcher.',
  },
  {
    id: 'uniswap-v4',
    name: 'Uniswap v4 (manual / other hooks)',
    launchesPer12h: 781,
    trades: 'v4-swap',
    notes: 'Pools with no hook or an unknown hook. Index only when one side is ETH/WETH/USDG and the other is a fresh token.',
  },
];

/** Smaller single-deployer v4 launchers seen (hook → launcher). Classified as 'uniswap-v4' for now. */
export const MINOR_V4_LAUNCHERS: Record<Address, Address> = {
  '0x0af57f62982d03066ef917acad87f771c06528ec': '0xd7e538e98a208fd19e46bc549ff4710c33664e18',
  '0x15e5e7206c661a1e881f5cd33a94eaf2328fa8cc': '0xaa7a943666b72a305a53962dd5b28c5f9d8a37a7',
  '0x48b8f6ad3a1b4aa477314c9a23035b8f84dde8cc': '0xd3f2cc1731b7fd17f28798835c2e02f0a1839a94',
  '0x745d717620052a97a22deee2e5eba59583f3e0cc': '0x16cf6788b762ee8969744586ed16fc5705140dd7',
};

/** Contracts that move tokens on behalf of users; never treat them as the trader or a holder cluster. */
export const INFRA_ADDRESSES: Address[] = [
  UNISWAP.v4.poolManager,
  UNISWAP.v4.positionManager,
  UNISWAP.v4.universalRouter,
  UNISWAP.permit2,
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789', // ERC-4337 EntryPoint v0.6
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
];

export function launchpadForHook(hook: Address): LaunchpadId | null {
  const h = hook.toLowerCase();
  for (const lp of LAUNCHPADS) if (lp.hooks?.includes(h as Address)) return lp.id;
  return null;
}

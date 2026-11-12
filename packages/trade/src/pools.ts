import { zeroAddress, type Address, type Hex, type PublicClient } from 'viem';
import { TRADE_ADDRESSES, V3_FEE_TIERS, V4_STANDARD_POOLS } from './addresses.ts';
import {
  ponsCurveAbi,
  ponsFactoryAbi,
  v2FactoryAbi,
  v2PairAbi,
  v3FactoryAbi,
  v4PositionManagerAbi,
  v4StateViewAbi,
} from './abis.ts';
import { sortCurrencies, v4PoolId, V4_DYNAMIC_FEE_FLAG } from './math.ts';
import type { Pool, PonsPool, QuoteAsset, V2Pool, V3Pool, V4Pool, Venue } from './types.ts';
import type { PoolKey } from './universal-router.ts';
import { ABIS, launchpadForHook } from '@rushr/core/chain/robinhood';

export interface DiscoverOptions {
  quoteAsset: QuoteAsset;
  /** Pool keys known from the indexer (best source for hooked pools such as Doppler and lift.fun). */
  v4Keys?: PoolKey[];
  /** `main_pool` from the Rushr API: a v4 pool id (bytes32) or a pool/curve address. */
  mainPool?: Hex | null;
  /** Restrict venues. Default: all. */
  venues?: Venue[];
  /** Address used to read the PONS snipe tax (the buyer). */
  trader?: Address;
  /** Token creation block (Rushr API `created_block`): bounds the Initialize-event lookup for hooked pools. */
  createdBlock?: bigint;
}

/** Blocks scanned after `createdBlock` for the pool's Initialize event (~18 min at 0.11 s blocks). */
const INITIALIZE_SCAN_BLOCKS = 10_000n;

/**
 * Pool key from the PoolManager Initialize event (one eth_getLogs call). Needed for hook-managed pools
 * (e.g. Doppler) that never registered in the PositionManager.
 */
export async function v4KeyFromInitialize(client: PublicClient, poolId: Hex, fromBlock: bigint): Promise<PoolKey | null> {
  const logs = await client.getLogs({
    address: TRADE_ADDRESSES.v4.poolManager,
    event: ABIS.v4PoolManager[0],
    args: { id: poolId },
    fromBlock,
    toBlock: fromBlock + INITIALIZE_SCAN_BLOCKS,
  });
  const a = logs[0]?.args;
  if (!a || !a.currency0 || !a.currency1 || a.fee === undefined || a.tickSpacing === undefined || !a.hooks) return null;
  return { currency0: a.currency0, currency1: a.currency1, fee: a.fee, tickSpacing: a.tickSpacing, hooks: a.hooks };
}

/** Pool-side quote currencies that serve a user-facing quote asset. */
export function poolQuotesFor(asset: QuoteAsset): Address[] {
  return asset === 'ETH' ? [TRADE_ADDRESSES.eth, TRADE_ADDRESSES.weth] : [TRADE_ADDRESSES.usdg];
}

function lc(a: string): Address {
  return a.toLowerCase() as Address;
}

function v4FeeLabel(fee: number, lpFee: number | null): { bps: number; label: string } {
  if (fee & V4_DYNAMIC_FEE_FLAG) {
    const bps = lpFee == null ? 0 : lpFee / 100;
    return { bps, label: lpFee == null ? 'dynamic pool fee' : `${(lpFee / 10_000).toFixed(2)}% dynamic pool fee` };
  }
  return { bps: fee / 100, label: `${(fee / 10_000).toFixed(2)}% pool fee` };
}

/**
 * Finds tradable pools for `token` against the chosen quote asset. Costs one batched round of
 * eth_calls (multicall when the client has `batch.multicall`), plus one more for pool state.
 */
export async function discoverPools(client: PublicClient, tokenIn: Address, opts: DiscoverOptions): Promise<Pool[]> {
  const token = lc(tokenIn);
  const venues = new Set<Venue>(opts.venues ?? ['uniswap-v4', 'uniswap-v3', 'uniswap-v2', 'pons-curve']);
  const quotes = poolQuotesFor(opts.quoteAsset);
  const erc20Quotes = quotes.filter((q) => q !== zeroAddress);
  const out: Pool[] = [];

  const tasks: Promise<void>[] = [];

  if (venues.has('pons-curve') && opts.quoteAsset === 'ETH') tasks.push(discoverPons(client, token, opts.trader).then((p) => void (p && out.push(p))));

  if (venues.has('uniswap-v3')) {
    for (const q of erc20Quotes)
      for (const fee of V3_FEE_TIERS)
        tasks.push(
          client
            .readContract({ address: TRADE_ADDRESSES.v3.factory, abi: v3FactoryAbi, functionName: 'getPool', args: [token, q, fee] })
            .then((addr) => {
              if (addr !== zeroAddress)
                out.push({ venue: 'uniswap-v3', id: lc(addr), token, quote: q, fee, venueFeeBps: fee / 100, venueFeeLabel: `Uniswap v3 · ${(fee / 10_000).toFixed(2)}% pool fee` } satisfies V3Pool);
            })
            .catch(() => undefined),
        );
  }

  if (venues.has('uniswap-v2')) {
    for (const q of erc20Quotes)
      tasks.push(
        client
          .readContract({ address: TRADE_ADDRESSES.v2.factory, abi: v2FactoryAbi, functionName: 'getPair', args: [token, q] })
          .then(async (pair) => {
            if (pair === zeroAddress) return;
            const [[r0, r1], token0] = await Promise.all([
              client.readContract({ address: pair, abi: v2PairAbi, functionName: 'getReserves' }),
              client.readContract({ address: pair, abi: v2PairAbi, functionName: 'token0' }),
            ]);
            const tokenIs0 = lc(token0) === token;
            const reserveToken = tokenIs0 ? r0 : r1;
            const reserveQuote = tokenIs0 ? r1 : r0;
            if (reserveToken > 0n && reserveQuote > 0n)
              out.push({ venue: 'uniswap-v2', id: lc(pair), token, quote: q, reserveToken, reserveQuote, venueFeeBps: 30, venueFeeLabel: 'Uniswap v2 · 0.30% pool fee' } satisfies V2Pool);
          })
          .catch(() => undefined),
      );
  }

  if (venues.has('uniswap-v4')) tasks.push(discoverV4(client, token, quotes, opts).then((ps) => void out.push(...ps)));

  await Promise.all(tasks);
  return out;
}

async function discoverPons(client: PublicClient, token: Address, trader?: Address): Promise<PonsPool | null> {
  try {
    const [, curveRaw] = await client.readContract({ address: TRADE_ADDRESSES.pons.factory, abi: ponsFactoryAbi, functionName: 'getLaunchedToken', args: [token] });
    if (curveRaw === zeroAddress) return null;
    const curve = lc(curveRaw);
    const [reserves, feeBps, creatorTaxBps, graduated, snipe] = await Promise.all([
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'getReserves' }),
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'feeBps' }),
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'creatorTaxBps' }),
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'graduated' }),
      client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'currentSnipeTaxBps', args: [trader ?? zeroAddress] }).catch(() => 0n),
    ]);
    const fee = Number(feeBps);
    const tax = Number(creatorTaxBps);
    return {
      venue: 'pons-curve',
      id: curve,
      curve,
      token,
      quote: TRADE_ADDRESSES.eth,
      quoteReserve: reserves[0],
      tokenReserve: reserves[1],
      feeBps: fee,
      creatorTaxBps: tax,
      snipeTaxBps: Number(snipe),
      graduated,
      venueFeeBps: fee + tax,
      venueFeeLabel: `PONS curve · ${(fee / 100).toFixed(2)}% fee + ${(tax / 100).toFixed(2)}% creator tax`,
    };
  } catch {
    return null;
  }
}

async function discoverV4(client: PublicClient, token: Address, quotes: Address[], opts: DiscoverOptions): Promise<V4Pool[]> {
  const keys = new Map<Hex, PoolKey>();
  const add = (k: PoolKey) => {
    const key = { ...k, currency0: lc(k.currency0), currency1: lc(k.currency1), hooks: lc(k.hooks) };
    keys.set(v4PoolId(key), key);
  };
  for (const k of opts.v4Keys ?? []) add(k);

  if (opts.mainPool && opts.mainPool.length === 66) {
    try {
      const [currency0, currency1, fee, tickSpacing, hooks] = await client.readContract({
        address: TRADE_ADDRESSES.v4.positionManager,
        abi: v4PositionManagerAbi,
        functionName: 'poolKeys',
        args: [opts.mainPool.slice(0, 52) as Hex],
      });
      if (currency0 !== zeroAddress || currency1 !== zeroAddress) add({ currency0, currency1, fee, tickSpacing, hooks });
      else if (opts.createdBlock !== undefined) {
        // Not registered in the PositionManager (hook-managed liquidity): read the Initialize event.
        const key = await v4KeyFromInitialize(client, opts.mainPool, opts.createdBlock);
        if (key) add(key);
      }
    } catch {
      /* unknown pool id */
    }
  }
  for (const q of quotes) {
    const [c0, c1] = sortCurrencies(q, token);
    for (const s of V4_STANDARD_POOLS) add({ currency0: c0, currency1: c1, fee: s.fee, tickSpacing: s.tickSpacing, hooks: zeroAddress });
  }

  const quoteSet = new Set(quotes.map(lc));
  const candidates = [...keys.entries()].filter(([, k]) => {
    const other = k.currency0 === token ? k.currency1 : k.currency1 === token ? k.currency0 : null;
    return other !== null && quoteSet.has(other);
  });

  const results = await Promise.all(
    candidates.map(async ([id, key]) => {
      try {
        const [sqrtPriceX96, , , lpFee] = await client.readContract({ address: TRADE_ADDRESSES.v4.stateView, abi: v4StateViewAbi, functionName: 'getSlot0', args: [id] });
        if (sqrtPriceX96 === 0n) return null;
        const fee = v4FeeLabel(key.fee, lpFee);
        const launchpad = key.hooks === zeroAddress ? null : launchpadForHook(key.hooks);
        const quote = key.currency0 === token ? key.currency1 : key.currency0;
        return {
          venue: 'uniswap-v4',
          id,
          key,
          hookData: '0x',
          token,
          quote,
          launchpad,
          venueFeeBps: fee.bps,
          venueFeeLabel: `Uniswap v4${launchpad ? ` (${launchpad} hook)` : key.hooks !== zeroAddress ? ' (hooked pool)' : ''} · ${fee.label}`,
        } satisfies V4Pool;
      } catch {
        return null;
      }
    }),
  );
  return results.filter((p): p is NonNullable<typeof p> => p !== null) as V4Pool[];
}

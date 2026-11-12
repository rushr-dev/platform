import { decodeEventLog, toEventSelector, type Address, type Hex } from 'viem';
import {
  ABIS,
  INFRA_ADDRESSES,
  NATIVE_ETH,
  ETH_USD_REFERENCE_POOLS,
  QUOTES,
  STOCK_QUOTES,
  TOPICS,
  UNISWAP,
  launchpadForHook,
  type LaunchpadId,
} from '../chain/robinhood';

/** eth_getLogs entry (Alchemy includes blockTimestamp). */
export interface RawLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockTimestamp?: Hex;
  transactionHash: Hex;
  logIndex: Hex;
}

export const TOPIC0 = {
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  v4Initialize: '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438',
  v4Swap: '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f',
  ...TOPICS,
} as const;

// Doppler Airlock topics, computed from the signatures so they can't drift.
export const DOPPLER_CREATE = toEventSelector('Create(address,address,address,address)');
export const DOPPLER_MIGRATE = toEventSelector('Migrate(address,address)');

/**
 * Chain-wide topics for the live socket: launches, v4 pools and swaps, curves, migrations.
 * Excludes ERC-20 Transfers and v3/v2 pair swaps (the socket bills per byte; pair swaps go on a
 * separate subscription filtered to the pools we track, see `PAIR_SWAP_TOPICS`).
 */
export function tradeTopics(): Hex[] {
  return subscribedTopics().filter((t) => t !== TOPIC0.transfer && !PAIR_SWAP_TOPICS.includes(t));
}

/** Launches, pool creations and migrations only (sparse): the first pass of a full-history backfill. */
export function catalogTopics(): Hex[] {
  return [TOPIC0.v4Initialize, DOPPLER_CREATE, DOPPLER_MIGRATE, TOPICS.liftLaunch, TOPICS.ponsLaunch, TOPICS.ponsGraduate];
}

/** All topic0s the indexer subscribes to, for one OR-filtered eth_getLogs call. */
export function subscribedTopics(): Hex[] {
  return [
    TOPIC0.transfer,
    TOPIC0.v4Initialize,
    TOPIC0.v4Swap,
    DOPPLER_CREATE,
    DOPPLER_MIGRATE,
    TOPICS.liftLaunch,
    TOPICS.ponsLaunch,
    TOPICS.ponsBuy,
    TOPICS.ponsSell,
    TOPICS.ponsGraduate,
    ...PAIR_SWAP_TOPICS,
  ];
}

/** Swap events of v3-style and v2-style pools (any factory). */
export const PAIR_SWAP_TOPICS: Hex[] = [TOPICS.v3Swap, TOPICS.pancakeV3Swap, TOPICS.v2Swap];


export interface Launch {
  token: Address;
  launchpad: LaunchpadId;
  creator: Address | null;
  quote: Address;
  pool: string | null; // v4 pool id or PONS curve
  block: bigint;
  time: number;
  tx: Hex;
}

export interface PoolInfo {
  id: string; // v4 pool id (bytes32) or PONS curve address
  token: Address;
  quote: Address;
  tokenIsCurrency0: boolean;
  /** Protocol family: how swaps are decoded. 'v3' and 'v2' cover every fork (see `venue`). */
  dex: 'uniswap-v4' | 'pons-curve' | 'v3' | 'v2';
  /** DEX name for v3/v2 pools (from PAIR_FACTORIES; 'other' when the factory isn't listed). */
  venue?: string | null;
  /** Pool key parts (v4: from Initialize or PositionManager; v3: fee()/tickSpacing()). Null when unknown or n/a. */
  fee?: number | null;
  tickSpacing?: number | null;
  launchpad: LaunchpadId | null;
  hooks: Address | null;
  block: bigint;
  time: number;
}

export interface DecodedSwap {
  tx: Hex;
  logIndex: number;
  block: bigint;
  time: number;
  pool: string;
  token: Address;
  quote: Address;
  trader: Address;
  side: 'buy' | 'sell';
  tokenAmount: bigint;
  quoteAmount: bigint;
}

export interface DecodedTransfer {
  tx: Hex;
  logIndex: number;
  block: bigint;
  time: number;
  token: Address;
  from: Address;
  to: Address;
  amount: bigint;
}

export interface Migration {
  token: Address;
  /** New main pool (v4 pool id), when known. */
  pool: string | null;
  block: bigint;
  time: number;
}

/** A swap on an ETH/USDG pool, used to track the ETH price on-chain. */
export interface EthUsdObservation {
  time: number;
  ethAmount: bigint; // 18 decimals
  usdgAmount: bigint; // 6 decimals
}

export interface DecodeContext {
  /** Pools seen before this range. */
  getPool(id: string): PoolInfo | undefined;
  /** Tokens already tracked before this range. */
  isTracked(token: Address): boolean;
  /**
   * A token to treat as the traded side even if it's normally a quote (a stock token's own page):
   * in its pools against ETH/WETH/USDG it is the token, not the quote.
   */
  focusToken?: Address;
  /**
   * Quote token of a PONS curve (its `pairToken()`: native ETH or USDG). PONS launch events don't
   * carry it, so the caller looks it up before decoding. Defaults to native ETH.
   */
  curveQuote?(curve: string): Address | undefined;
}

export interface DecodeResult {
  launches: Launch[];
  pools: PoolInfo[];
  swaps: DecodedSwap[];
  transfers: DecodedTransfer[];
  migrations: Migration[];
  ethUsd: EthUsdObservation[];
  /** v4 pool ids that had swaps but whose Initialize we never saw (resolve, then decode again). */
  unknownPools: string[];
  /** Addresses that emitted v3/v2 Swap events and aren't known pools (resolve token0/token1, then decode again). */
  unknownPairs: string[];
}

const ETH_LIKE = new Set<string>([NATIVE_ETH, QUOTES.WETH]);
/** Quotes a stock token can be traded against on its own page. */
const CORE_QUOTES = new Set<string>([NATIVE_ETH, QUOTES.WETH, QUOTES.USDG]);
const QUOTE_SET = new Set<string>([NATIVE_ETH, QUOTES.WETH, QUOTES.USDG, ...Object.values(STOCK_QUOTES)]);
const INFRA = new Set<string>(INFRA_ADDRESSES.map((a) => a.toLowerCase()));
const POOL_MANAGER = UNISWAP.v4.poolManager.toLowerCase();

const lc = (a: string) => a.toLowerCase() as Address;
const topicAddr = (t: Hex | undefined) => lc(`0x${(t ?? '').slice(26)}`);
const word = (data: Hex, i: number) => `0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}` as Hex;
const uint = (data: Hex, i: number) => BigInt(word(data, i));

function meta(l: RawLog) {
  return {
    tx: l.transactionHash,
    logIndex: Number(l.logIndex),
    block: BigInt(l.blockNumber),
    time: l.blockTimestamp ? Number(l.blockTimestamp) : 0,
  };
}

/**
 * Decode one block range of logs. Two passes: launches and pools first (a token's mint
 * Transfer comes before its launch event in the same tx), then swaps and transfers.
 */
export function decodeLogs(logs: RawLog[], ctx: DecodeContext): DecodeResult {
  const out: DecodeResult = { launches: [], pools: [], swaps: [], transfers: [], migrations: [], ethUsd: [], unknownPools: [], unknownPairs: [] };
  const unknown = new Set<string>();
  const unknownPairs = new Set<string>();
  const newPools = new Map<string, PoolInfo>();
  const newTokens = new Set<string>();
  const launchByToken = new Map<string, Launch>();
  const refPools = new Map<string, { ethIs0: boolean }>(ETH_USD_REFERENCE_POOLS.map((id) => [id, { ethIs0: true }])); // ETH/USDG pools for price
  const getPool = (id: string) => newPools.get(id) ?? ctx.getPool(id);
  const tracked = (t: string) => newTokens.has(t) || ctx.isTracked(t as Address);
  // v3/v2 pools are contracts holding the token: never the trader.
  const isPool = (a: Address) => {
    const p = getPool(a);
    return p?.dex === 'v3' || p?.dex === 'v2';
  };

  // ---- pass 1: launches and pools
  for (const l of logs) {
    const t0 = l.topics[0];
    const m = meta(l);
    if (t0 === TOPIC0.v4Initialize && lc(l.address) === POOL_MANAGER) {
      const ev = decodeEventLog({ abi: ABIS.v4PoolManager, eventName: 'Initialize', data: l.data, topics: l.topics as never });
      const c0 = lc(ev.args.currency0);
      const c1 = lc(ev.args.currency1);
      const id = ev.args.id.toLowerCase();
      const focus = ctx.focusToken?.toLowerCase();
      const q0 = QUOTE_SET.has(c0) && !(c0 === focus && CORE_QUOTES.has(c1));
      const q1 = QUOTE_SET.has(c1) && !(c1 === focus && CORE_QUOTES.has(c0));
      if (q0 && q1) {
        if ((ETH_LIKE.has(c0) && c1 === QUOTES.USDG) || (ETH_LIKE.has(c1) && c0 === QUOTES.USDG)) {
          refPools.set(id, { ethIs0: ETH_LIKE.has(c0) });
        }
        continue;
      }
      if (!q0 && !q1) continue;
      const hooks = lc(ev.args.hooks);
      const pool: PoolInfo = {
        id,
        token: q0 ? c1 : c0,
        quote: q0 ? c0 : c1,
        tokenIsCurrency0: !q0,
        dex: 'uniswap-v4',
        launchpad: launchpadForHook(hooks) ?? 'uniswap-v4',
        hooks: hooks === NATIVE_ETH ? null : hooks,
        fee: Number(ev.args.fee),
        tickSpacing: Number(ev.args.tickSpacing),
        block: m.block,
        time: m.time,
      };
      newPools.set(id, pool);
      out.pools.push(pool);
      if (!tracked(pool.token)) {
        newTokens.add(pool.token);
        const launch: Launch = {
          token: pool.token, launchpad: pool.launchpad!, creator: null, quote: pool.quote, pool: id, block: m.block, time: m.time, tx: m.tx,
        };
        launchByToken.set(pool.token, launch);
      }
    } else if (t0 === DOPPLER_CREATE) {
      const ev = decodeEventLog({ abi: ABIS.dopplerAirlock, eventName: 'Create', data: l.data, topics: l.topics as never });
      const token = lc(ev.args.asset);
      newTokens.add(token);
      const prev = launchByToken.get(token);
      launchByToken.set(token, {
        token, launchpad: 'doppler', creator: null, quote: lc(ev.args.numeraire), pool: prev?.pool ?? null, block: m.block, time: m.time, tx: m.tx,
      });
    } else if (t0 === TOPICS.liftLaunch) {
      const token = topicAddr(l.topics[1]);
      newTokens.add(token);
      launchByToken.set(token, {
        token, launchpad: 'liftfun', creator: topicAddr(l.topics[2]), quote: lc(`0x${word(l.data, 0).slice(26)}`),
        pool: (l.topics[3] ?? '').toLowerCase() || null, block: m.block, time: m.time, tx: m.tx,
      });
    } else if (t0 === TOPICS.ponsLaunch) {
      const token = topicAddr(l.topics[1]);
      const curve = topicAddr(l.topics[2]);
      newTokens.add(token);
      const quote = ctx.curveQuote?.(curve) ?? NATIVE_ETH;
      launchByToken.set(token, {
        token, launchpad: 'pons', creator: topicAddr(l.topics[3]), quote, pool: curve, block: m.block, time: m.time, tx: m.tx,
      });
      const pool: PoolInfo = {
        id: curve, token, quote, tokenIsCurrency0: false, dex: 'pons-curve', launchpad: 'pons', hooks: null, block: m.block, time: m.time,
      };
      newPools.set(curve, pool);
      out.pools.push(pool);
    } else if (t0 === DOPPLER_MIGRATE) {
      out.migrations.push({ token: topicAddr(l.topics[1]), pool: topicAddr(l.topics[2]), block: m.block, time: m.time });
    } else if (t0 === TOPICS.ponsGraduate) {
      const curve = getPool(lc(l.address));
      if (curve?.dex === 'pons-curve') {
        // The PONS v2 pool is initialized in the same tx.
        const v2 = logs.find(
          (x) => x.transactionHash === l.transactionHash && x.topics[0] === TOPIC0.v4Initialize && x.topics[3] && topicAddr(x.topics[3]) === curve.token,
        );
        out.migrations.push({ token: curve.token, pool: v2?.topics[1]?.toLowerCase() ?? null, block: m.block, time: m.time });
      }
    }
  }
  // Doppler: pool id comes from the Initialize in the same tx.
  for (const launch of launchByToken.values()) {
    if (launch.launchpad === 'doppler' && !launch.pool) {
      const p = out.pools.find((p) => p.token === launch.token);
      if (p) {
        launch.pool = p.id;
        p.launchpad = 'doppler';
      }
    } else if (launch.pool) {
      const p = newPools.get(launch.pool);
      if (p && launch.launchpad !== 'uniswap-v4') p.launchpad = launch.launchpad;
    }
  }
  out.launches = [...launchByToken.values()];

  // ---- pass 2: transfers (tracked tokens only), then swaps
  const txTransfers = new Map<string, DecodedTransfer[]>();
  for (const l of logs) {
    if (l.topics[0] !== TOPIC0.transfer || l.topics.length !== 3) continue;
    const token = lc(l.address);
    if (!tracked(token)) continue;
    const m = meta(l);
    const tr: DecodedTransfer = { ...m, token, from: topicAddr(l.topics[1]), to: topicAddr(l.topics[2]), amount: BigInt(l.data) };
    out.transfers.push(tr);
    const list = txTransfers.get(m.tx) ?? [];
    list.push(tr);
    txTransfers.set(m.tx, list);
  }

  for (const l of logs) {
    const t0 = l.topics[0];
    const m = meta(l);
    if (t0 === TOPIC0.v4Swap && lc(l.address) === POOL_MANAGER) {
      const id = (l.topics[1] ?? '').toLowerCase();
      const ref = refPools.get(id);
      const a0 = signed128(word(l.data, 0));
      const a1 = signed128(word(l.data, 1));
      if (ref) {
        const eth = ref.ethIs0 ? a0 : a1;
        const usd = ref.ethIs0 ? a1 : a0;
        if (eth !== 0n && usd !== 0n) out.ethUsd.push({ time: m.time, ethAmount: abs(eth), usdgAmount: abs(usd) });
        continue;
      }
      const pool = getPool(id);
      if (!pool) {
        unknown.add(id);
        continue;
      }
      const tokenDelta = pool.tokenIsCurrency0 ? a0 : a1;
      const quoteDelta = pool.tokenIsCurrency0 ? a1 : a0;
      if (tokenDelta === 0n) continue;
      const side = tokenDelta > 0n ? 'buy' : 'sell'; // amounts are from the swapper's side
      out.swaps.push({
        ...m, pool: id, token: pool.token, quote: pool.quote, side,
        trader: resolveTrader(txTransfers.get(m.tx), pool.token, side, topicAddr(l.topics[2]), isPool),
        tokenAmount: abs(tokenDelta), quoteAmount: abs(quoteDelta),
      });
    } else if (t0 === TOPICS.v3Swap || t0 === TOPICS.pancakeV3Swap || t0 === TOPICS.v2Swap) {
      const addr = lc(l.address);
      const pool = getPool(addr);
      if (!pool) {
        unknownPairs.add(addr);
        continue;
      }
      if (pool.dex !== 'v3' && pool.dex !== 'v2') continue;
      const swap = decodePairSwap(l, pool);
      if (!swap) continue;
      out.swaps.push({
        ...m, pool: addr, token: pool.token, quote: pool.quote, side: swap.side,
        trader: resolveTrader(txTransfers.get(m.tx), pool.token, swap.side, topicAddr(l.topics[2]), isPool),
        tokenAmount: swap.tokenAmount, quoteAmount: swap.quoteAmount,
      });
    } else if (t0 === TOPICS.ponsBuy || t0 === TOPICS.ponsSell) {
      const pool = getPool(lc(l.address));
      if (!pool) continue;
      const buy = t0 === TOPICS.ponsBuy;
      out.swaps.push({
        ...m, pool: pool.id, token: pool.token, quote: pool.quote, side: buy ? 'buy' : 'sell',
        trader: topicAddr(l.topics[2] ?? l.topics[1]),
        // buy: [quoteIn, tokensOut, fee, fee]; sell: [tokensIn, quoteOut, fee, fee] (quote = ETH or USDG)
        tokenAmount: buy ? uint(l.data, 1) : uint(l.data, 0),
        quoteAmount: buy ? uint(l.data, 0) : uint(l.data, 1),
      });
    }
  }
  out.unknownPools = [...unknown];
  out.unknownPairs = [...unknownPairs];
  return out;
}

/**
 * One v3-style or v2-style Swap log, from the swapper's side.
 * v3 (and forks): amount0/amount1 are int256 deltas of the *pool* (positive = paid into the pool),
 * so the swapper buys the token when the pool's token amount is negative.
 * v2: amount0In, amount1In, amount0Out, amount1Out (In = paid into the pair).
 */
export function decodePairSwap(
  l: Pick<RawLog, 'topics' | 'data'>,
  pool: Pick<PoolInfo, 'tokenIsCurrency0'>,
): { side: 'buy' | 'sell'; tokenAmount: bigint; quoteAmount: bigint } | null {
  const t0 = l.topics[0];
  if (t0 === TOPICS.v3Swap || t0 === TOPICS.pancakeV3Swap) {
    if (l.data.length < 2 + 64 * 2) return null;
    const a0 = signed256(word(l.data, 0));
    const a1 = signed256(word(l.data, 1));
    const tok = pool.tokenIsCurrency0 ? a0 : a1;
    const quo = pool.tokenIsCurrency0 ? a1 : a0;
    if (tok === 0n) return null;
    return { side: tok < 0n ? 'buy' : 'sell', tokenAmount: abs(tok), quoteAmount: abs(quo) };
  }
  if (t0 === TOPICS.v2Swap) {
    if (l.data.length < 2 + 64 * 4) return null;
    const [in0, in1, out0, out1] = [0, 1, 2, 3].map((i) => uint(l.data, i)) as [bigint, bigint, bigint, bigint];
    // Net per side (a pair can be paid on both sides in one swap, e.g. fee-on-transfer refunds).
    const tok = pool.tokenIsCurrency0 ? out0 - in0 : out1 - in1; // > 0: swapper received tokens
    const quo = pool.tokenIsCurrency0 ? in1 - out1 : in0 - out0;
    if (tok === 0n) return null;
    return { side: tok > 0n ? 'buy' : 'sell', tokenAmount: abs(tok), quoteAmount: abs(quo) };
  }
  return null;
}

/** The wallet that ends up with the token (buy) or first gives it up (sell), skipping routers. */
export function resolveTrader(
  transfers: DecodedTransfer[] | undefined,
  token: Address,
  side: 'buy' | 'sell',
  fallback: Address,
  /** Known pools are skipped too: in a multi-pool route the token passes through other pools. */
  isPool: (a: Address) => boolean = () => false,
): Address {
  const own = (transfers ?? []).filter((t) => t.token === token);
  const skip = (a: Address) => INFRA.has(a) || isPool(a);
  if (side === 'buy') {
    for (let i = own.length - 1; i >= 0; i--) {
      const to = own[i]!.to;
      if (!skip(to)) return to;
    }
  } else {
    for (const t of own) if (!skip(t.from)) return t.from;
  }
  return fallback;
}

function signed256(w: Hex): bigint {
  const v = BigInt(w);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}
function signed128(w: Hex): bigint {
  const v = BigInt(w);
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}
const abs = (v: bigint) => (v < 0n ? -v : v);

import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, pad, toHex, type Address, type Hex } from 'viem';
import { ABIS, NATIVE_ETH, QUOTES, TOPICS, UNISWAP } from '../src/chain/robinhood';
import { decodeLogs, type DecodeContext, type RawLog } from '../src/ingest/decode';

const PM = UNISWAP.v4.poolManager as Address;
const TOKEN = '0xf771128f0326524a98a8d249f13fcdb728fcffff' as Address;
const USER = '0x1111111111111111111111111111111111111111' as Address;
const POOL_ID = `0x${'ab'.repeat(32)}` as Hex;
const DOPPLER_HOOK = '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544' as Address;
const emptyCtx: DecodeContext = { getPool: () => undefined, isTracked: () => false };

let logIndex = 0;
function log(address: Address, topics: Hex[], data: Hex, tx = '0x01'): RawLog {
  return {
    address, topics, data,
    blockNumber: '0x64', blockTimestamp: '0x6731a000',
    transactionHash: pad(tx as Hex, { size: 32 }), logIndex: toHex(logIndex++),
  };
}

function initLog(c0: Address, c1: Address, hooks: Address) {
  const topics = encodeEventTopics({ abi: ABIS.v4PoolManager, eventName: 'Initialize', args: { id: POOL_ID, currency0: c0, currency1: c1 } });
  const data = encodeAbiParameters(
    [{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }],
    [3000, 60, hooks, 2n ** 96n, 0],
  );
  return log(PM, topics as Hex[], data);
}

function swapLog(a0: bigint, a1: bigint, tx: string) {
  const topics = encodeEventTopics({ abi: ABIS.v4PoolManager, eventName: 'Swap', args: { id: POOL_ID, sender: UNISWAP.v4.universalRouter as Address } });
  const data = encodeAbiParameters(
    [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }],
    [a0, a1, 2n ** 96n, 1n, 0, 3000],
  );
  return log(PM, topics as Hex[], data, tx);
}

function transferLog(token: Address, from: Address, to: Address, amount: bigint, tx: string) {
  const topics = encodeEventTopics({ abi: ABIS.erc20, eventName: 'Transfer', args: { from, to } });
  return log(token, topics as Hex[], encodeAbiParameters([{ type: 'uint256' }], [amount]), tx);
}

describe('decodeLogs: Uniswap v4', () => {
  it('registers a Doppler pool and decodes buys and sells from the swapper side', () => {
    // currency0 = USDG, currency1 = token (USDG sorts lower)
    const logs = [
      initLog(QUOTES.USDG as Address, TOKEN, DOPPLER_HOOK),
      // buy: swapper pays 40,718 USDG units, receives tokens; router forwards them to USER
      swapLog(-40718n, 10_643n * 10n ** 18n, '0x02'),
      transferLog(TOKEN, PM, UNISWAP.v4.universalRouter as Address, 10_643n * 10n ** 18n, '0x02'),
      transferLog(TOKEN, UNISWAP.v4.universalRouter as Address, USER, 10_643n * 10n ** 18n, '0x02'),
      // sell: swapper pays tokens, receives USDG
      transferLog(TOKEN, USER, PM, 5n * 10n ** 18n, '0x03'),
      swapLog(20_000n, -5n * 10n ** 18n, '0x03'),
    ];
    const r = decodeLogs(logs, emptyCtx);
    expect(r.pools).toHaveLength(1);
    expect(r.pools[0]).toMatchObject({ token: TOKEN, quote: QUOTES.USDG, tokenIsCurrency0: false, launchpad: 'doppler' });
    expect(r.launches[0]).toMatchObject({ token: TOKEN, launchpad: 'doppler' });
    expect(r.swaps.map((s) => [s.side, s.trader, s.tokenAmount, s.quoteAmount])).toEqual([
      ['buy', USER, 10_643n * 10n ** 18n, 40718n],
      ['sell', USER, 5n * 10n ** 18n, 20_000n],
    ]);
    // transfers of the new token are tracked in the same range
    expect(r.transfers).toHaveLength(3);
  });

  it('uses ETH/USDG pools as the ETH price reference, not as tokens', () => {
    const logs = [initLog(NATIVE_ETH, QUOTES.USDG as Address, NATIVE_ETH), swapLog(-(10n ** 18n), 3500_000000n, '0x04')];
    const r = decodeLogs(logs, emptyCtx);
    expect(r.pools).toHaveLength(0);
    expect(r.ethUsd).toEqual([{ time: 0x6731a000, ethAmount: 10n ** 18n, usdgAmount: 3500_000000n }]);
  });
});

describe('decodeLogs: PONS curve', () => {
  it('maps a launch to its curve and decodes curve buys and sells', () => {
    const curve = '0xd6915857f90dec51141f26970be3368967c28f54' as Address;
    const creator = '0x39bdee788bd249d199cdaef9e69c98402f78f182' as Address;
    const t = (a: Address) => pad(a, { size: 32 });
    const words = (...v: bigint[]) => encodeAbiParameters(v.map(() => ({ type: 'uint256' })), v);
    const logs = [
      log('0xe33e9e479df8802cb0866d5d05258bec4cf62948', [TOPICS.ponsLaunch, t(TOKEN), t(curve), t(creator)], words(0n, 2n * 10n ** 16n, 10n ** 24n)),
      log(curve, [TOPICS.ponsBuy, t(USER), t(USER)], words(10n ** 16n, 5n * 10n ** 23n, 1n, 1n)),
      log(curve, [TOPICS.ponsSell, t(USER), t(USER)], words(10n ** 23n, 2n * 10n ** 15n, 1n, 1n)),
    ];
    const r = decodeLogs(logs, emptyCtx);
    expect(r.launches[0]).toMatchObject({ token: TOKEN, launchpad: 'pons', creator, pool: curve });
    expect(r.swaps.map((s) => [s.side, s.tokenAmount, s.quoteAmount])).toEqual([
      ['buy', 5n * 10n ** 23n, 10n ** 16n],
      ['sell', 10n ** 23n, 2n * 10n ** 15n],
    ]);
  });
});

describe('decodeLogs: v3 / v2 pairs (any factory)', () => {
  const PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571' as Address;
  const t = (a: Address) => pad(a, { size: 32 });
  const pairCtx = (pools: Record<string, { tokenIsCurrency0: boolean; dex: 'v3' | 'v2'; quote: Address }>): DecodeContext => ({
    isTracked: (a) => a === PONS,
    getPool: (id) => {
      const p = pools[id];
      return p && { id, token: PONS, launchpad: null, hooks: null, block: 0n, time: 0, venue: null, ...p };
    },
  });

  it('decodes a real Aero CL swap (WETH/PONS, token1 = PONS): PONS paid into the pool is a sell', () => {
    const pool = '0x1d87bbf4643bc7569db04353fa29af8225918eb5' as Address;
    const l = log(
      pool,
      [TOPICS.v3Swap, '0x0000000000000000000000009ee35bf1bd69a03c6f0393582030fce8bb93d418', '0x000000000000000000000000082738d007001080a00099a000004f3006152085'],
      '0xffffffffffffffffffffffffffffffffffffffffffffffffffe39228e4db71c6000000000000000000000000000000000000000000000005fc1b394aff79a4df00000000000000000000000000000000000000752501376f66f13722a1fecf1400000000000000000000000000000000000000000000004025dd2d31f35144880000000000000000000000000000000000000000000000000000000000017428',
    );
    const r = decodeLogs([l], pairCtx({ [pool]: { tokenIsCurrency0: false, dex: 'v3', quote: QUOTES.WETH as Address } }));
    expect(r.unknownPairs).toEqual([]);
    expect(r.swaps).toHaveLength(1);
    expect(r.swaps[0]).toMatchObject({
      side: 'sell', pool, token: PONS, quote: QUOTES.WETH,
      tokenAmount: 0x5fc1b394aff79a4dfn,
      quoteAmount: (1n << 256n) - 0xffffffffffffffffffffffffffffffffffffffffffffffffffe39228e4db71c6n,
      // no transfers in this test: falls back to the recipient topic
      trader: '0x082738d007001080a00099a000004f3006152085',
    });
  });

  it('decodes a v3 buy (token0 = PONS paid out by the pool) and resolves the trader from transfers', () => {
    const pool = '0x7a192e71564ec66ee0763e328a3ac274942de4e1' as Address;
    const router = '0x278d858f05b94576c1e6f73285886876ff6ef8d2' as Address;
    const data = encodeAbiParameters(
      [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }],
      [-(700n * 10n ** 18n), 100_000_000n, 2n ** 96n, 1n, 0],
    );
    const logs = [
      transferLog(PONS, pool, router, 700n * 10n ** 18n, '0x10'),
      transferLog(PONS, router, USER, 700n * 10n ** 18n, '0x10'),
      log(pool, [TOPICS.v3Swap, t(router), t(router)], data, '0x10'),
    ];
    const r = decodeLogs(logs, pairCtx({ [pool]: { tokenIsCurrency0: true, dex: 'v3', quote: QUOTES.USDG as Address } }));
    expect(r.swaps.map((s) => [s.side, s.trader, s.tokenAmount, s.quoteAmount])).toEqual([['buy', USER, 700n * 10n ** 18n, 100_000_000n]]);
  });

  it('skips other known pools when resolving the trader of a multi-pool route', () => {
    const a = '0x10cc6bd38112cac182db90b6a71d8bb5939526ba' as Address;
    const b = '0xed50bdeea8adc232f159486192a4157281d722ff' as Address;
    const data = encodeAbiParameters(
      [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }],
      [10n ** 16n, -(5n * 10n ** 18n), 2n ** 96n, 1n, 0],
    );
    // a pays PONS to b (an arb leg), b pays USER: USER is the buyer, not pool b
    const logs = [
      transferLog(PONS, a, USER, 5n * 10n ** 18n, '0x11'),
      transferLog(PONS, USER, b, 1n, '0x11'),
      log(a, [TOPICS.v3Swap, t(USER), t(USER)], data, '0x11'),
    ];
    const ctx = pairCtx({
      [a]: { tokenIsCurrency0: false, dex: 'v3', quote: QUOTES.WETH as Address },
      [b]: { tokenIsCurrency0: false, dex: 'v3', quote: QUOTES.WETH as Address },
    });
    expect(decodeLogs(logs, ctx).swaps[0]).toMatchObject({ side: 'buy', trader: USER });
  });

  it('decodes a real PancakeSwap-v3-style swap (giga) the same way', () => {
    const pool = '0x50e43b43a8ee1e07e0ac978e92adff7dfbfb88e7' as Address;
    const l = log(
      pool,
      [TOPICS.pancakeV3Swap, '0x000000000000000000000000278d858f05b94576c1e6f73285886876ff6ef8d2', '0x000000000000000000000000278d858f05b94576c1e6f73285886876ff6ef8d2'],
      '0xfffffffffffffffffffffffffffffffffffffffffffffffffffbe43a1d767685000000000000000000000000000000000000000000000000ddac130fe163aa12000000000000000000000000000000000000007585bc5a7e68c8b686eb9084bd000000000000000000000000000000000000000000000003cc350fb99923a2280000000000000000000000000000000000000000000000000000000000017469000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000717f039da280db',
    );
    const r = decodeLogs([l], pairCtx({ [pool]: { tokenIsCurrency0: false, dex: 'v3', quote: QUOTES.WETH as Address } }));
    expect(r.swaps[0]).toMatchObject({ side: 'sell', tokenAmount: 0xddac130fe163aa12n });
  });

  it('decodes a real Uniswap v2 swap (WETH/PONS): PONS in, WETH out is a sell', () => {
    const pair = '0x8018ee3ad3c0321be0e69536733cd28e29564dd4' as Address;
    const l = log(
      pair,
      [TOPICS.v2Swap, '0x000000000000000000000000278d858f05b94576c1e6f73285886876ff6ef8d2', '0x000000000000000000000000278d858f05b94576c1e6f73285886876ff6ef8d2'],
      '0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000009791d98fb81bf16da000000000000000000000000000000000000000000000000002cee54bff5d9f80000000000000000000000000000000000000000000000000000000000000000',
    );
    const r = decodeLogs([l], pairCtx({ [pair]: { tokenIsCurrency0: false, dex: 'v2', quote: QUOTES.WETH as Address } }));
    expect(r.swaps[0]).toMatchObject({ side: 'sell', tokenAmount: 0x9791d98fb81bf16dan, quoteAmount: 0x2cee54bff5d9f8n });
  });

  it('decodes a v2 buy and reports unknown pair addresses for resolution', () => {
    const pair = '0x8018ee3ad3c0321be0e69536733cd28e29564dd4' as Address;
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [10n ** 17n, 0n, 0n, 42n * 10n ** 18n]);
    const r = decodeLogs([log(pair, [TOPICS.v2Swap, t(USER), t(USER)], data)], pairCtx({ [pair]: { tokenIsCurrency0: false, dex: 'v2', quote: QUOTES.WETH as Address } }));
    expect(r.swaps[0]).toMatchObject({ side: 'buy', tokenAmount: 42n * 10n ** 18n, quoteAmount: 10n ** 17n, trader: USER });
    const other = '0x9999999999999999999999999999999999999999' as Address;
    expect(decodeLogs([log(other, [TOPICS.v2Swap, t(USER), t(USER)], data)], emptyCtx).unknownPairs).toEqual([other]);
  });

  it('keeps pair swaps off the chain-wide live socket topics', async () => {
    const { tradeTopics, subscribedTopics, PAIR_SWAP_TOPICS } = await import('../src/ingest/decode');
    for (const topic of PAIR_SWAP_TOPICS) {
      expect(subscribedTopics()).toContain(topic);
      expect(tradeTopics()).not.toContain(topic);
    }
  });

  it('has topic constants that match the event signatures', async () => {
    const { toEventSelector } = await import('viem');
    expect(toEventSelector(ABIS.v3[1]!)).toBe(TOPICS.v3Swap);
    expect(toEventSelector(ABIS.pancakeV3[0]!)).toBe(TOPICS.pancakeV3Swap);
    expect(toEventSelector(ABIS.v2[1]!)).toBe(TOPICS.v2Swap);
  });
});

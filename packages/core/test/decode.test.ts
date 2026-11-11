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

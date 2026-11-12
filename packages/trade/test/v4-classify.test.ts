import { describe, expect, it } from 'vitest';
import { encodeErrorResult, parseAbi, type Address, type PublicClient } from 'viem';
import { quickBuy, quickSell, nonEthQuoteGuard } from '../src/quick';
import type { ApiPoolRow } from '../src/api-pools';
import type { V4Pool } from '../src/types';

const TOKEN: Address = '0xa5d7a0df79ab3a43cde8b0a31e4b3458b962a540';
const trader: Address = '0x2222222222222222222222222222222222222222';
const ID = '0xe2da1f00de83683e633de32a50f249ec5aeee3c05dab463c5d7824ae100d8027' as const;
const pool = {
  venue: 'uniswap-v4', id: ID, token: TOKEN, quote: '0x0000000000000000000000000000000000000000', launchpad: null, hookData: '0x', venueFeeBps: 100, venueFeeLabel: 'Uniswap v4 · 1.00%',
  key: { currency0: '0x0000000000000000000000000000000000000000', currency1: TOKEN, fee: 10000, tickSpacing: 200, hooks: '0x0000000000000000000000000000000000000000' },
} as unknown as V4Pool;
const nel = encodeErrorResult({ abi: parseAbi(['error NotEnoughLiquidity(bytes32 poolId)']), errorName: 'NotEnoughLiquidity', args: [ID] });

/** A v4 pool with zero active liquidity; `fills` says which swap directions the quoter can fill. */
function client(fills: { zeroForOne: boolean; oneForZero: boolean }) {
  return {
    simulateContract: async ({ args }: { args: [{ zeroForOne: boolean }] }) => {
      if (args[0].zeroForOne ? fills.zeroForOne : fills.oneForZero) return { result: [10n ** 18n, 100_000n] };
      throw Object.assign(new Error('reverted'), { cause: { data: nel } });
    },
    readContract: async ({ functionName }: { functionName: string }) => (functionName === 'getLiquidity' ? 0n : [2n ** 96n, 0, 0, 10000]),
    getBalance: async () => 10n ** 18n,
    getGasPrice: async () => 20_000_000n,
  } as unknown as PublicClient;
}
const opts = { discover: { pools: [pool] }, simulate: false, assume: { ethWei: 10n ** 18n, tokenWei: 10n ** 24n } };

describe('v4 pools that can not quote', () => {
  it('liquidity withdrawn (neither direction fills) → LIQUIDITY_REMOVED, on buys and sells', async () => {
    const c = client({ zeroForOne: false, oneForZero: false });
    expect((await quickBuy(c, { token: TOKEN, ethWei: 10n ** 15n, trader }, opts)).blockers.map((b) => b.code)).toEqual(['LIQUIDITY_REMOVED']);
    expect((await quickSell(c, { token: TOKEN, trader, amount: 10n ** 20n }, opts)).blockers.map((b) => b.code)).toEqual(['LIQUIDITY_REMOVED']);
  });

  it('launch pool with only the token side: buys quote, sells say "nothing to sell into yet" (not "withdrawn")', async () => {
    const c = client({ zeroForOne: true, oneForZero: false }); // ETH (currency0) → token fills
    const buy = await quickBuy(c, { token: TOKEN, ethWei: 10n ** 15n, trader }, opts);
    expect(buy.blockers).toEqual([]);
    const sell = await quickSell(c, { token: TOKEN, trader, amount: 10n ** 20n }, opts);
    expect(sell.blockers).toEqual([{ code: 'NO_ROUTE', message: expect.stringContaining('Nothing to sell into yet') }]);
  });

  it('a token that only trades against USDG or a stock token says so', () => {
    const row = (quote: string) => ({ pool: ID, dex: 'uniswap', version: 'v4', launchpad: 'doppler', quote, token_is_currency0: false, key: null, liquidity_usd: null, volume_24h_usd: 0, trades_24h: 0 }) as ApiPoolRow;
    expect(nonEthQuoteGuard([row('0x5fc5360d0400a0fd4f2af552add042d716f1d168')])?.message).toContain('against USDG');
    expect(nonEthQuoteGuard([row('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec')])?.message).toContain('against NVDA');
    expect(nonEthQuoteGuard([row('0x0bd7d308f8e1639fab988df18a8011f41eacad73')])).toBeNull(); // WETH is ETH
    expect(nonEthQuoteGuard(null)).toBeNull();
  });
});

import { decodeFunctionData, erc20Abi } from 'viem';
import { describe, expect, it } from 'vitest';
import { CASHBACK_MIN, NATIVE_FEE_TOKEN, payable, txBuilderFile } from '../src/cashback';
import { DEFAULT_TRADE_CONFIG } from '../src/config';
import { cashbackOf } from '../src/referral';

const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const A = '0xa11ce00000000000000000000000000000000001';
const B = '0xb0b0000000000000000000000000000000000002';
const SAFE = '0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3';

describe('cashback', () => {
  it('is 30% of the fee actually paid, rounded down, and nothing on a missed fee', () => {
    expect(DEFAULT_TRADE_CONFIG.cashbackShareBps).toBe(3_000);
    expect(cashbackOf(10n ** 15n, DEFAULT_TRADE_CONFIG)).toBe(3n * 10n ** 14n);
    expect(cashbackOf(7n, DEFAULT_TRADE_CONFIG)).toBe(2n);
    expect(cashbackOf(0n, DEFAULT_TRADE_CONFIG)).toBe(0n);
  });

  it('pays what is owed above the minimum, largest first, and skips unknown fee tokens', () => {
    const rows = [
      { wallet: A, feeToken: NATIVE_FEE_TOKEN, owed: CASHBACK_MIN[NATIVE_FEE_TOKEN]! - 1n },
      { wallet: B, feeToken: NATIVE_FEE_TOKEN, owed: 5n * 10n ** 14n },
      { wallet: A, feeToken: USDG, owed: 3_000_000n },
      { wallet: B, feeToken: '0x1111111111111111111111111111111111111111', owed: 10n ** 30n },
    ];
    expect(payable(rows).map((r) => [r.wallet, r.feeToken])).toEqual([
      [B, NATIVE_FEE_TOKEN],
      [A, USDG],
    ]);
  });

  it('builds a Transaction Builder file: ETH as value transfers, USDG as transfer() calls', () => {
    const f = txBuilderFile({ safe: SAFE, chainId: 4663, batch: '2026-12-01', createdAt: 1, payouts: [
      { wallet: B, feeToken: NATIVE_FEE_TOKEN, owed: 5n * 10n ** 14n },
      { wallet: A, feeToken: USDG, owed: 3_000_000n },
    ] });
    expect(f).toMatchObject({ chainId: '4663', meta: { name: 'Rushr cashback 2026-12-01', createdFromSafeAddress: SAFE } });
    expect(f.transactions[0]).toMatchObject({ value: '500000000000000', data: null });
    expect(f.transactions[0]!.to.toLowerCase()).toBe(B);
    expect(f.transactions[1]).toMatchObject({ value: '0' });
    expect(f.transactions[1]!.to.toLowerCase()).toBe(USDG);
    const call = decodeFunctionData({ abi: erc20Abi, data: f.transactions[1]!.data! });
    expect(call).toMatchObject({ functionName: 'transfer', args: [expect.stringMatching(/^0xa11ce0+1$/i), 3_000_000n] });
  });
});

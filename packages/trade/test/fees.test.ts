import { describe, expect, it } from 'vitest';
import { feeOf, minOut, sellMinimums, slippageWithTax, splitBuyInput, splitSellOutput, priceImpactBps } from '../src/fees';
import { assertSignable, DEFAULT_TRADE_CONFIG, MAX_FEE_BPS, PLACEHOLDER_FEE_RECIPIENT, resolveConfig } from '../src/config';
import { isTradeError, sanitizeRpcMessage } from '../src/errors';

describe('fee math', () => {
  it('takes bps of the amount, rounding down', () => {
    expect(feeOf(10n ** 16n, 100)).toBe(10n ** 14n);
    expect(feeOf(199n, 100)).toBe(1n); // 1.99 -> 1
    expect(feeOf(99n, 100)).toBe(0n);
    expect(feeOf(123_456_789n, 0)).toBe(0n);
  });

  it('splits a buy: fee off the input, the rest is swapped', () => {
    const { fee, swapAmount } = splitBuyInput(10n ** 16n, 100);
    expect(fee).toBe(10n ** 14n);
    expect(swapAmount).toBe(99n * 10n ** 14n);
    expect(fee + swapAmount).toBe(10n ** 16n);
  });

  it('splits a sell: fee off the gross output, identical to PAY_PORTION', () => {
    const gross = 9_840_691_000_000_000n;
    const { fee, netOut } = splitSellOutput(gross, 100);
    expect(fee).toBe((gross * 100n) / 10_000n);
    expect(netOut + fee).toBe(gross);
  });

  it('rejects non-positive buy amounts', () => {
    expect(() => splitBuyInput(0n, 100)).toThrowError(/amount/);
  });

  it('applies slippage and keeps sell minimums consistent with the fee', () => {
    expect(minOut(10_000n, 100)).toBe(9_900n);
    expect(() => minOut(1n, 10_000)).toThrow();
    expect(() => minOut(1n, -1)).toThrow();
    const { minGross, minNet } = sellMinimums(1_000_000n, 100, 300);
    expect(minGross).toBe(970_000n);
    expect(minNet).toBe(970_000n - 9_700n);
  });

  it('adds measured tax to slippage and caps at 50%', () => {
    expect(slippageWithTax(100, 500, 0, 'buy')).toBe(600);
    expect(slippageWithTax(100, 0, 800, 'sell')).toBe(900);
    expect(slippageWithTax(100, 9_000, 0, 'buy')).toBe(5_000);
  });

  it('computes price impact against spot', () => {
    expect(priceImpactBps(10_000n, 9_900n)).toBe(100);
    expect(priceImpactBps(10_000n, 10_100n)).toBe(0);
  });
});

describe('config', () => {
  it('defaults to the founder treasury; a placeholder treasury is still refused', () => {
    const cfg = resolveConfig();
    expect(cfg.feeBps).toBe(DEFAULT_TRADE_CONFIG.feeBps);
    expect(cfg.feeBps).toBe(50); // founder decision: 0.5%
    expect([cfg.referralDiscountBps, cfg.referrerShareBps]).toEqual([1_000, 2_000]);
    expect(cfg.feeRecipient).toBe('0x447a590b70cd55Cc6B62CEaf79D4c6c09A955E40');
    expect(() => assertSignable(cfg)).not.toThrow();
    try {
      assertSignable(resolveConfig({ feeRecipient: PLACEHOLDER_FEE_RECIPIENT }));
      expect.unreachable();
    } catch (e) {
      expect(isTradeError(e, 'FEE_RECIPIENT_PLACEHOLDER')).toBe(true);
    }
  });

  it('accepts a real treasury', () => {
    const cfg = resolveConfig({ feeRecipient: '0x1234567890abcdef1234567890abcdef12345678' });
    expect(() => assertSignable(cfg)).not.toThrow();
    expect(cfg.feeRecipient).toBe('0x1234567890AbcdEF1234567890aBcdef12345678');
  });

  it('caps the fee and rejects bad recipients', () => {
    expect(() => resolveConfig({ feeBps: MAX_FEE_BPS + 1 })).toThrow(/feeBps/);
    expect(() => resolveConfig({ feeBps: 1.5 })).toThrow(/feeBps/);
    expect(() => resolveConfig({ feeRecipient: '0x0000000000000000000000000000000000000000' })).toThrow(/feeRecipient/);
    expect(() => resolveConfig({ feeRecipient: '0xnope' as `0x${string}` })).toThrow(/feeRecipient/);
    expect(() => resolveConfig({ referrerShareBps: 10_001 })).toThrow(/referrerShareBps/);
  });

  it('never leaks RPC URLs in error text', () => {
    const e = Object.assign(new Error('x'), { shortMessage: 'HTTP request failed. URL: https://rpc.example/v2/SECRETKEY\nmore' });
    expect(sanitizeRpcMessage(e)).toBe('HTTP request failed. URL: <rpc>');
  });
});

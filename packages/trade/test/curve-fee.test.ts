import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, pad, type Address, type Hex, type PublicClient } from 'viem';
import { auditCurveFee, CURVE_BUY_TOPIC, CURVE_FEE_GAS, CURVE_SELL_TOPIC, curveFillFromLogs, followUpFeeCall, maxBuyWei, tradeFollowUpFee, type CurveFeeFollowUp, type FeeTxInfo } from '../src/curve-fee';
import { quickBuy, quickSell } from '../src/quick';
import { RUSHR_TREASURY } from '../src/config';
import type { PonsPool } from '../src/types';

const TRADER: Address = '0x2222222222222222222222222222222222222222';
const OTHER: Address = '0x3333333333333333333333333333333333333333';
const TOKEN: Address = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const CURVE: Address = '0xdb0f18faf3e0c9e26733ceeaefc3b8a188028050';
const E = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const fake = { getGasPrice: async () => 100_000_000n } as unknown as PublicClient;
// A live curve's state (AEON, 2026-11-13): 1% curve fee + 2% creator tax.
const live = {
  venue: 'pons-curve', id: CURVE, curve: CURVE, token: TOKEN, quote: '0x0000000000000000000000000000000000000000', graduated: false, nativeQuote: true, snipeTaxBps: 0,
  quoteReserve: 3849605092614506915n, tokenReserve: 436408400233855505010127109n, feeBps: 100, creatorTaxBps: 200,
  realQuoteReserve: 2169605092614506915n, graduationThreshold: 4200000000000000000n, sellableTokens: 150694114519569790724412824n,
  venueFeeBps: 300, venueFeeLabel: 'PONS curve · 1.00% fee + 2.00% creator tax',
} as unknown as PonsPool;
const opts = (o: object = {}) => ({ discover: { pools: [live] }, simulate: false, assume: { ethWei: E(1), tokenWei: 10n ** 24n }, settings: { slippageBps: 500 }, now: () => 1_000_000, ...o });

/** A CurveBuy / CurveSell log as the curve emits it (checked against a live simulation, see test/live/curve-fee.live.test.ts). */
const fillLog = (side: 'buy' | 'sell', who: Address, quote: bigint, tokens: bigint, curve: Address = CURVE) => ({
  address: curve,
  topics: [side === 'buy' ? CURVE_BUY_TOPIC : CURVE_SELL_TOPIC, pad(who), pad(who)],
  data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], side === 'buy' ? [quote, tokens, quote / 100n, quote / 50n] : [tokens, quote, quote / 100n, quote / 50n]),
});
const follow = (side: 'buy' | 'sell', feeBps = 25): CurveFeeFollowUp => ({ kind: 'curve-fee', side, curve: CURVE, trader: TRADER, treasury: RUSHR_TREASURY, feeBps, quotedFee: 0n });

describe('curve fee math (from the receipt)', () => {
  it('buy: 0.25% of the ETH the curve took, sent to the treasury with no calldata', () => {
    const call = followUpFeeCall(follow('buy'), { status: 'success', logs: [fillLog('buy', TRADER, E(0.01), 10n ** 24n)] });
    expect(call).toEqual({ label: 'Rushr fee', chainId: 4663, to: RUSHR_TREASURY, value: E(0.000025), data: '0x', gas: CURVE_FEE_GAS });
  });

  it('a buy that completes the curve pays on what the curve took, not on the refunded part', () => {
    // Sent 4.2518 ETH; the curve took 4.2018 and refunded the rest (seen live in a simulation).
    const call = followUpFeeCall(follow('buy'), { status: 'success', logs: [fillLog('buy', TRADER, 4201835102149195522n, 1n)] });
    expect(call!.value).toBe((4201835102149195522n * 25n) / 10_000n);
  });

  it('sell: 0.25% of the ETH the curve paid out', () => {
    const call = followUpFeeCall(follow('sell'), { status: 'success', logs: [fillLog('sell', TRADER, 9313155096045520n, 10n ** 24n)] });
    expect(call!.value).toBe((9313155096045520n * 25n) / 10_000n);
  });

  it('referred traders pay the discounted rate (22 bps), same as on Universal Router routes', async () => {
    const ref = { referrer: OTHER };
    const b = await quickBuy(fake, { token: TOKEN, ethWei: E(0.1), trader: TRADER, referral: ref }, opts());
    expect(b.quote!.fee).toMatchObject({ feeBps: 22, baseFeeBps: 25, feeAmount: (E(0.1) * 22n) / 10_000n, referralDiscountAmount: (E(0.1) * 25n) / 10_000n - (E(0.1) * 22n) / 10_000n });
    expect(b.quote!.fee.referrerAccrual).toBeGreaterThan(0n);
    expect(b.feeFollowUp!.feeBps).toBe(22);
    const s = await quickSell(fake, { token: TOKEN, trader: TRADER, amount: 10n ** 24n, referral: ref }, opts());
    expect(s.quote!.fee.feeBps).toBe(22);
    expect(s.quote!.amountOut).toBe(s.quote!.grossOut - (s.quote!.grossOut * 22n) / 10_000n);
    expect(followUpFeeCall(b.feeFollowUp!, { status: 'success', logs: [fillLog('buy', TRADER, E(0.1), 1n)] })!.value).toBe((E(0.1) * 22n) / 10_000n);
  });
});

describe('fee only after a successful trade', () => {
  it('no fee transfer when the trade reverted', () => {
    expect(followUpFeeCall(follow('buy'), { status: 'reverted', logs: [fillLog('buy', TRADER, E(0.01), 1n)] })).toBeNull();
  });
  it('no fee transfer when the receipt has no fill for this trader, curve or side', () => {
    expect(followUpFeeCall(follow('buy'), { status: 'success', logs: [] })).toBeNull();
    expect(followUpFeeCall(follow('buy'), { status: 'success', logs: [fillLog('buy', OTHER, E(0.01), 1n)] })).toBeNull();
    expect(followUpFeeCall(follow('buy'), { status: 'success', logs: [fillLog('buy', TRADER, E(0.01), 1n, OTHER)] })).toBeNull();
    expect(followUpFeeCall(follow('buy'), { status: 'success', logs: [fillLog('sell', TRADER, E(0.01), 1n)] })).toBeNull();
  });
  it('no fee transfer on Universal Router trades (the fee is inside the swap) or when it rounds to 0', () => {
    expect(tradeFollowUpFee({ feeFollowUp: null }, { status: 'success', logs: [fillLog('buy', TRADER, E(0.01), 1n)] })).toBeNull();
    expect(followUpFeeCall(follow('buy'), { status: 'success', logs: [fillLog('buy', TRADER, 399n, 1n)] })).toBeNull();
  });
});

describe('balance reservation', () => {
  it('Max leaves room for the fee on top: amount + fee <= spendable', () => {
    for (const s of [E(1), E(0.0123), 10_001n, 1n]) {
      const m = maxBuyWei(s, 25);
      expect(m + (m * 25n) / 10_000n).toBeLessThanOrEqual(s);
      expect(m + 1n + ((m + 1n) * 25n) / 10_000n).toBeGreaterThan(s - 1n); // as large as it can be (within a wei)
    }
    expect(maxBuyWei(E(1), 0)).toBe(E(1));
    expect(maxBuyWei(-5n, 25)).toBe(0n);
  });

  it('a curve buy needs the amount + the fee + gas for both transactions', async () => {
    const ok = await quickBuy(fake, { token: TOKEN, ethWei: E(0.1), trader: TRADER }, opts());
    // gas = (buy floor + fee transfer) × 2 × gas price
    expect(ok.gasCostWei).toBe((250_000n + CURVE_FEE_GAS) * 100_000_000n * 2n);
    const exact = E(0.1) + E(0.00025) + ok.gasCostWei;
    expect((await quickBuy(fake, { token: TOKEN, ethWei: E(0.1), trader: TRADER }, opts({ assume: { ethWei: exact } }))).blockers).toEqual([]);
    const short = await quickBuy(fake, { token: TOKEN, ethWei: E(0.1), trader: TRADER }, opts({ assume: { ethWei: exact - 1n } }));
    expect(short.blockers.map((b) => b.code)).toEqual(['INSUFFICIENT_ETH']);
    expect(short.blockers[0]!.message).toContain('the Rushr fee');
  });
});

describe('curve fee audit', () => {
  const trade = { hash: `0x${'aa'.repeat(32)}` as Hex, from: TRADER, nonce: 7, value: E(0.01), status: 'success' as const, logs: [fillLog('buy', TRADER, E(0.01), 1n)], treasury: RUSHR_TREASURY, feeBps: 25, referredFeeBps: 22 };
  const feeTx = (o: Partial<FeeTxInfo> = {}): FeeTxInfo => ({ hash: `0x${'bb'.repeat(32)}`, from: TRADER, to: RUSHR_TREASURY, value: E(0.000025), input: '0x', nonce: 8, status: 'success', ...o });

  it('passes a fee transfer at the next nonce with the expected rate', () => {
    const a = auditCurveFee({ ...trade, feeTx: feeTx() });
    expect(a).toMatchObject({ side: 'buy', notional: E(0.01), expectedFee: E(0.000025), fee: E(0.000025), feeBps: 25, expectedBps: 25, flags: [] });
  });
  it('infers the referred rate when the referrer is unknown', () => {
    expect(auditCurveFee({ ...trade, feeTx: feeTx({ value: (E(0.01) * 22n) / 10_000n }) })).toMatchObject({ expectedBps: 22, flags: [] });
  });
  it('flags a missing, wrong or misdirected fee transfer', () => {
    expect(auditCurveFee({ ...trade, feeTx: null }).flags).toEqual(['fee_missed']);
    expect(auditCurveFee({ ...trade, feeTx: feeTx({ nonce: 9 }) }).flags).toEqual(['fee_tx_nonce_9_expected_8']);
    expect(auditCurveFee({ ...trade, feeTx: feeTx({ to: OTHER }) }).flags).toEqual(['fee_tx_wrong_recipient']);
    expect(auditCurveFee({ ...trade, feeTx: feeTx({ from: OTHER }) }).flags).toEqual(['fee_tx_wrong_sender']);
    expect(auditCurveFee({ ...trade, feeTx: feeTx({ status: 'reverted' }) }).flags).toEqual(['fee_tx_reverted']);
    expect(auditCurveFee({ ...trade, feeTx: feeTx({ value: E(0.00005) }), referred: false }).flags).toEqual(['fee_bps_50_expected_25']);
  });
  it('a reverted trade expects no fee, and flags one that was paid anyway', () => {
    expect(auditCurveFee({ ...trade, status: 'reverted', feeTx: null }).flags).toEqual(['reverted']);
    expect(auditCurveFee({ ...trade, status: 'reverted', feeTx: feeTx() }).flags).toEqual(['reverted', 'fee_paid_on_failed_trade']);
  });
});

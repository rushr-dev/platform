import { describe, expect, it } from 'vitest';
import { pad, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { resolveConfig } from '../src/config';
import { auditFee, type AuditLog, type CallFrame, type FeeAuditInput } from '../src/fee-audit';
import { buildSwap } from '../src/build';
import { quotePool } from '../src/quote';
import { effectiveFeeBps } from '../src/referral';
import { TRADE_ADDRESSES } from '../src/addresses';
import type { SwapRequest, V2Pool } from '../src/types';

const TREASURY: Address = '0x1111111111111111111111111111111111111111';
const TRADER: Address = '0x2222222222222222222222222222222222222222';
const TOKEN: Address = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const UR = TRADE_ADDRESSES.universalRouter;
const cfg = resolveConfig({ feeRecipient: TREASURY }); // beta default: 25 bps, 22 referred
const pool: V2Pool = { venue: 'uniswap-v2', id: '0x8018ee3ad3000000000000000000000000000000', token: TOKEN, quote: TRADE_ADDRESSES.weth, reserveToken: 10n ** 24n, reserveQuote: 10n ** 20n, venueFeeBps: 30, venueFeeLabel: 'v2' };
const req = (side: SwapRequest['side'], amountIn: bigint, referred = false): SwapRequest => ({ side, token: TOKEN, quoteAsset: 'ETH', amountIn, trader: TRADER, slippageBps: 100, referral: referred ? { referrer: '0x5555555555555555555555555555555555555555' } : null });
const eth = (to: Address, value: bigint): CallFrame => ({ type: 'CALL', from: UR, to, value: toHex(value) });
const erc20 = (token: Address, from: Address, to: Address, value: bigint): AuditLog => ({ address: token, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad(from), pad(to)], data: toHex(value, { size: 32 }) });
const H: Hex = `0x${'ab'.repeat(32)}`;
const input = (data: Hex, value: bigint, calls: CallFrame[], logs: AuditLog[] = [], over: Partial<FeeAuditInput> = {}): FeeAuditInput => ({
  hash: H, from: TRADER, to: UR, value, input: data, status: 'success', logs, trace: { type: 'CALL', from: TRADER, to: UR, value: toHex(value), calls }, treasury: TREASURY, feeBps: cfg.feeBps, referredFeeBps: effectiveFeeBps(cfg, { referrer: TREASURY }), ...over,
});

describe('fee audit', () => {
  it('a beta buy: the TRANSFER of 25 bps of msg.value reached the treasury', async () => {
    const q = await quotePool({} as PublicClient, pool, req('buy', 10n ** 18n), cfg);
    const b = buildSwap(q, cfg);
    const a = auditFee(input(b.tx.data, b.tx.value, [eth(TREASURY, q.fee.feeAmount)], [erc20(TOKEN, pool.id as Address, TRADER, q.amountOut)]));
    expect(a).toMatchObject({ side: 'buy', quoteAsset: 'ETH', notional: 10n ** 18n, fee: 25n * 10n ** 14n, feeBps: 25, expectedBps: 25, calldataBps: 25, flags: [] });
    expect(a.commands).toEqual([{ command: 'TRANSFER', asset: '0x0000000000000000000000000000000000000000', value: 25n * 10n ** 14n }]);
  });

  it('a referred sell: PAY_PORTION 22 bips of the gross ETH out; the referred rate is inferred from the calldata', async () => {
    const q = await quotePool({} as PublicClient, pool, req('sell', 10n ** 21n, true), cfg);
    const b = buildSwap(q, cfg);
    const a = auditFee(input(b.tx.data, 0n, [eth(TREASURY, q.fee.feeAmount), eth(TRADER, q.amountOut)], [erc20(TOKEN, TRADER, pool.id as Address, 10n ** 21n)]));
    expect(a).toMatchObject({ side: 'sell', notional: q.grossOut, fee: q.fee.feeAmount, expectedBps: 22, calldataBps: 22, flags: [] });
    expect(Math.abs(a.feeBps! - 22)).toBeLessThan(0.01);
  });

  it('flags a trade where the treasury got nothing, or the wrong asset, or the wrong rate', async () => {
    const q = await quotePool({} as PublicClient, pool, req('sell', 10n ** 21n), cfg);
    const b = buildSwap(q, cfg);
    // The fee went out as WETH instead of ETH.
    const weth = auditFee(input(b.tx.data, 0n, [eth(TRADER, q.amountOut)], [erc20(TRADE_ADDRESSES.weth, UR, TREASURY, q.fee.feeAmount)]));
    expect(weth.flags).toEqual(['fee_wrong_asset_WETH', 'no_fee']);
    // A buy the treasury was never paid on (no fee command at all).
    const none = auditFee(input('0x3593564c' as Hex, 10n ** 18n, []));
    expect(none.flags).toEqual(['no_fee_command', 'no_fee']);
    // The calldata charged the standard 50 bps while 25 was expected.
    const std = resolveConfig({ feeRecipient: TREASURY, feeBps: 50 });
    const q50 = await quotePool({} as PublicClient, pool, req('buy', 10n ** 18n), std);
    const b50 = buildSwap(q50, std);
    const off = auditFee(input(b50.tx.data, 10n ** 18n, [eth(TREASURY, q50.fee.feeAmount)], [], { referred: false }));
    expect(off.flags).toEqual(['calldata_bps_50_expected_25', 'fee_bps_50_expected_25']);
  });

  it('reverted, and no trace available', async () => {
    expect(auditFee(input('0x', 0n, [], [], { status: 'reverted' })).flags).toEqual(['reverted']);
    const q = await quotePool({} as PublicClient, pool, req('buy', 10n ** 18n), cfg);
    const b = buildSwap(q, cfg);
    const a = auditFee(input(b.tx.data, b.tx.value, [], [], { trace: null }));
    expect(a.flags).toEqual(['no_trace']); // can't see ETH without a trace; not reported as no_fee
  });
});

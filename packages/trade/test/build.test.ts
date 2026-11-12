import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, zeroAddress, type Address, type PublicClient } from 'viem';
import { buildSwap, planUniversalRouter } from '../src/build';
import { resolveConfig } from '../src/config';
import { isTradeError } from '../src/errors';
import { isBuildable, quotePool, rankQuotes } from '../src/quote';
import { analyzeSwapTransfers, NATIVE_TRANSFER_EMITTER, type TransferEvent } from '../src/simulate';
import { TRADE_ADDRESSES, UR_ADDRESS_THIS, UR_MSG_SENDER } from '../src/addresses';
import { rushrPonsRouterAbi } from '../src/abis';
import { universalRouterAbi } from '../src/universal-router';
import type { PonsPool, Quote, SwapRequest, V2Pool, V3Pool, V4Pool } from '../src/types';

const TREASURY: Address = '0x1111111111111111111111111111111111111111';
const TRADER: Address = '0x2222222222222222222222222222222222222222';
const TOKEN: Address = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const cfg = resolveConfig({ feeBps: 100, feeRecipient: TREASURY });
// v2 and PONS quotes are pure math: no RPC is touched.
const noRpc = {} as PublicClient;

const v2Pool: V2Pool = { venue: 'uniswap-v2', id: '0x8018ee3ad3000000000000000000000000000000', token: TOKEN, quote: TRADE_ADDRESSES.weth, reserveToken: 10n ** 24n, reserveQuote: 10n ** 20n, venueFeeBps: 30, venueFeeLabel: 'v2' };
const v2Usdg: V2Pool = { ...v2Pool, quote: TRADE_ADDRESSES.usdg, reserveQuote: 10n ** 12n };
const v3Pool: V3Pool = { venue: 'uniswap-v3', id: '0xed50bdeea8000000000000000000000000000000', token: TOKEN, quote: TRADE_ADDRESSES.weth, fee: 3000, venueFeeBps: 30, venueFeeLabel: 'v3' };
const v4Pool: V4Pool = {
  venue: 'uniswap-v4',
  id: '0x6073975413484a350101c0c5d592a91ceb6c3ee881ad359613a08359fd1495a0',
  key: { currency0: zeroAddress, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
  hookData: '0x',
  token: TOKEN,
  quote: zeroAddress,
  venueFeeBps: 30,
  venueFeeLabel: 'v4',
};
const ponsPool: PonsPool = {
  venue: 'pons-curve',
  id: '0xdb0f18faf3e0c9e26733ceeaefc3b8a188028050',
  curve: '0xdb0f18faf3e0c9e26733ceeaefc3b8a188028050',
  token: TOKEN,
  quote: zeroAddress,
  quoteReserve: 2368777388466264608n,
  tokenReserve: 709226628124716270229357752n,
  feeBps: 100,
  creatorTaxBps: 125,
  snipeTaxBps: 0,
  graduated: false,
  realQuoteReserve: 688777388466264608n,
  graduationThreshold: 4_200_000_000_000_000_000n,
  sellableTokens: 423512342410430555943643467n,
  venueFeeBps: 225,
  venueFeeLabel: 'PONS',
};

function req(side: SwapRequest['side'], amountIn: bigint, quoteAsset: SwapRequest['quoteAsset'] = 'ETH'): SwapRequest {
  return { side, token: TOKEN, quoteAsset, amountIn, trader: TRADER, slippageBps: 100 };
}

/** A quote with fixed numbers for pools whose venue quote needs RPC (v3/v4). */
function fixedQuote(pool: V3Pool | V4Pool, side: SwapRequest['side']): Quote {
  const amountIn = 10n ** 16n;
  const buy = side === 'buy';
  return {
    request: req(side, amountIn),
    pool,
    amountIn,
    swapAmountIn: buy ? amountIn - 10n ** 14n : amountIn,
    grossOut: 1000n,
    amountOut: buy ? 1000n : 990n,
    minAmountOut: buy ? 990n : 970n,
    minGrossOut: buy ? 990n : 980n,
    slippageBps: 100,
    fee: { side, feeToken: zeroAddress, feeBps: 100, baseFeeBps: 100, feeAmount: buy ? 10n ** 14n : 10n, referralDiscountAmount: 0n, referrerAccrual: 0n, venueFeeBps: 30, venueFeeLabel: '' },
    expectedRefund: 0n,
    priceImpactBps: 0,
    gasEstimate: null,
    warnings: [],
  };
}

const decodeTriple = (input: `0x${string}`) => decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], input);

describe('buy plans take the fee from the quote-side input first', () => {
  it('v4 native ETH: TRANSFER fee, then V4_SWAP settled from the router', () => {
    const built = buildSwap(fixedQuote(v4Pool, 'buy'), cfg, { now: 1_000 });
    expect(built.commands.map((c) => c.label)).toEqual(['TRANSFER', 'V4_SWAP(SWAP_EXACT_IN_SINGLE,SETTLE,TAKE_ALL)']);
    expect(decodeTriple(built.commands[0]!.input)).toEqual([zeroAddress, TREASURY, 10n ** 14n]);
    expect(built.tx).toMatchObject({ to: cfg.universalRouter, value: 10n ** 16n });
    expect(built.approvals).toEqual([]);
    const d = decodeFunctionData({ abi: universalRouterAbi, data: built.tx.data });
    expect(d.args[0]).toBe('0x0510');
    expect(d.args[2]).toBe(1_000n + BigInt(cfg.deadlineSeconds));
  });

  it('v3 WETH: TRANSFER fee, WRAP_ETH the rest, swap to the user', () => {
    const q = fixedQuote(v3Pool, 'buy');
    const cmds = planUniversalRouter(q, cfg);
    expect(cmds.map((c) => c.label)).toEqual(['TRANSFER', 'WRAP_ETH', 'V3_SWAP_EXACT_IN']);
    const [wrapTo, wrapAmt] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], cmds[1]!.input);
    expect([wrapTo, wrapAmt]).toEqual([UR_ADDRESS_THIS, q.swapAmountIn]);
    const [recipient, amountIn, minOut, , payerIsUser] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }, { type: 'uint256[]' }],
      cmds[2]!.input,
    );
    expect([recipient, amountIn, minOut, payerIsUser]).toEqual([UR_MSG_SENDER, q.swapAmountIn, q.minAmountOut, false]);
  });

  it('v2 USDG: fee and input pulled via Permit2, approvals requested', async () => {
    const q = await quotePool(noRpc, v2Usdg, req('buy', 25_000_000n, 'USDG'), cfg);
    expect(q.fee.feeAmount).toBe(250_000n);
    expect(q.fee.feeToken).toBe(TRADE_ADDRESSES.usdg);
    const built = buildSwap(q, cfg);
    expect(built.commands.map((c) => c.label)).toEqual(['PERMIT2_TRANSFER_FROM', 'V2_SWAP_EXACT_IN']);
    expect(built.tx.value).toBe(0n);
    expect(built.approvals.map((a) => [a.kind, a.token, a.spender])).toEqual([
      ['erc20', TRADE_ADDRESSES.usdg, TRADE_ADDRESSES.permit2],
      ['permit2', TRADE_ADDRESSES.usdg, cfg.universalRouter],
    ]);
  });

  it('no fee commands at 0 bps', () => {
    const zero = resolveConfig({ feeBps: 0, feeRecipient: TREASURY });
    const q = { ...fixedQuote(v4Pool, 'buy'), fee: { ...fixedQuote(v4Pool, 'buy').fee, feeAmount: 0n } };
    expect(planUniversalRouter(q, zero).map((c) => c.label)).toEqual(['V4_SWAP(SWAP_EXACT_IN_SINGLE,SETTLE,TAKE_ALL)']);
  });
});

describe('sell plans take the fee from the output', () => {
  it('v2 WETH: swap into the router, unwrap, PAY_PORTION, SWEEP the net minimum', async () => {
    const q = await quotePool(noRpc, v2Pool, req('sell', 10n ** 21n), cfg);
    expect(q.fee.feeAmount).toBe((q.grossOut * 100n) / 10_000n);
    expect(q.amountOut).toBe(q.grossOut - q.fee.feeAmount);
    const built = buildSwap(q, cfg);
    expect(built.commands.map((c) => c.label)).toEqual(['V2_SWAP_EXACT_IN', 'UNWRAP_WETH', 'PAY_PORTION', 'SWEEP']);
    expect(decodeTriple(built.commands[2]!.input)).toEqual([zeroAddress, TREASURY, 100n]);
    expect(decodeTriple(built.commands[3]!.input)).toEqual([zeroAddress, UR_MSG_SENDER, q.minAmountOut]);
    expect(built.tx.value).toBe(0n);
    expect(built.approvals.map((a) => a.kind)).toEqual(['erc20', 'permit2']);
  });

  it('v4 native ETH: TAKE into the router, then fee and sweep', () => {
    const built = buildSwap(fixedQuote(v4Pool, 'sell'), cfg);
    expect(built.commands.map((c) => c.label)).toEqual(['V4_SWAP(SWAP_EXACT_IN_SINGLE,SETTLE_ALL,TAKE)', 'PAY_PORTION', 'SWEEP']);
  });

  it('a signed PermitSingle replaces the on-chain Permit2 approval', () => {
    const permit = { details: { token: TOKEN, amount: 10n ** 16n, expiration: 2_000, nonce: 0 }, spender: cfg.universalRouter, sigDeadline: 2_000n };
    const built = buildSwap(fixedQuote(v3Pool, 'sell'), cfg, { permit: { permit, signature: `0x${'11'.repeat(65)}` } });
    expect(built.commands[0]!.label).toBe('PERMIT2_PERMIT');
    expect(built.approvals.map((a) => a.kind)).toEqual(['erc20']);
  });
});

describe('PONS curve routes', () => {
  it('quote the curve exactly, with our fee on the input', async () => {
    const q = await quotePool(noRpc, ponsPool, req('buy', 10n ** 15n + 10n ** 13n + 10n ** 11n), cfg);
    expect(q.fee.feeAmount).toBe((q.amountIn * 100n) / 10_000n);
    expect(q.warnings.join(' ')).toMatch(/not deployed/);
  });

  it('cannot be built without RushrPonsRouter', async () => {
    const q = await quotePool(noRpc, ponsPool, req('buy', 10n ** 15n), cfg);
    expect(() => buildSwap(q, cfg)).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_VENUE' }));
    expect(isBuildable(ponsPool, cfg)).toBe(false);
  });

  it('builds RushrPonsRouter calls when configured', async () => {
    const withRouter = resolveConfig({ feeRecipient: TREASURY, ponsRouter: '0x3333333333333333333333333333333333333333' });
    const buy = buildSwap(await quotePool(noRpc, ponsPool, req('buy', 10n ** 15n), withRouter), withRouter);
    expect(buy.tx.value).toBe(10n ** 15n);
    const d = decodeFunctionData({ abi: rushrPonsRouterAbi, data: buy.tx.data });
    expect(d.functionName).toBe('buy');
    const sell = buildSwap(await quotePool(noRpc, ponsPool, req('sell', 10n ** 24n), withRouter), withRouter);
    expect(sell.approvals).toEqual([{ kind: 'erc20', token: TOKEN, spender: '0x3333333333333333333333333333333333333333', amount: 10n ** 24n }]);
  });

  it('refuses graduated curves', async () => {
    await expect(quotePool(noRpc, { ...ponsPool, graduated: true }, req('buy', 10n ** 15n), cfg)).rejects.toSatisfy((e) => isTradeError(e, 'CURVE_GRADUATED'));
  });
});

describe('route ranking', () => {
  it('ranks by what the user receives and prefers buildable routes', async () => {
    const a = await quotePool(noRpc, ponsPool, req('buy', 10n ** 16n), cfg);
    const b = await quotePool(noRpc, v2Pool, req('buy', 10n ** 16n), cfg);
    const ranked = rankQuotes([b, a]);
    expect(ranked[0]!.amountOut >= ranked[1]!.amountOut).toBe(true);
  });
});

describe('transfer analysis (simulation results)', () => {
  const q = fixedQuote(v4Pool, 'buy');
  const pm = TRADE_ADDRESSES.v4.poolManager;
  const t = (token: Address, from: Address, to: Address, value: bigint): TransferEvent => ({ token, from, to, value, callIndex: 0 });

  it('measures received amount and fee on a clean buy', () => {
    const r = analyzeSwapTransfers(q, [t(NATIVE_TRANSFER_EMITTER, cfg.universalRouter, TREASURY, 10n ** 14n), t(TOKEN, pm, TRADER, 1000n)], TREASURY);
    expect(r).toEqual({ received: 1000n, feePaid: 10n ** 14n, tokenTaxBps: 0 });
  });

  it('detects a 5% transfer tax on buys', () => {
    const r = analyzeSwapTransfers(q, [t(TOKEN, pm, TRADER, 950n), t(TOKEN, pm, '0x4444444444444444444444444444444444444444', 50n)], TREASURY);
    expect(r.tokenTaxBps).toBe(500);
  });

  it('detects a sell tax from what reaches the pool', () => {
    const sq = fixedQuote(v4Pool, 'sell');
    const r = analyzeSwapTransfers(sq, [t(TOKEN, TRADER, pm, 900n), t(TOKEN, TRADER, '0x4444444444444444444444444444444444444444', 100n), t(NATIVE_TRANSFER_EMITTER, pm, TRADER, 5n)], TREASURY);
    expect(r.tokenTaxBps).toBe(1000);
    expect(r.received).toBe(5n);
  });
});

import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, pad, type Address, type Hex, type PublicClient } from 'viem';
import { prepareQuickTrade, quickBuy, quickSell } from '../src/quick';
import { RUSHR_TREASURY } from '../src/config';
import { TRADE_ADDRESSES, UR_ADDRESS_THIS, UR_MSG_SENDER } from '../src/addresses';
import { CONTRACT_BALANCE, universalRouterAbi } from '../src/universal-router';
import { erc20Abi, permit2Abi, ponsCurveAbi } from '../src/abis';
import { formatPairAmount, pathImpactBps, planPairSwap, type PairPools } from '../src/pair-route';
import { finalizePairLeg, pairHeldMessage, pairReceived } from '../src/pair-trade';
import { ponsBuyCapped, ponsSellOut, v2AmountOut } from '../src/math';
import type { PonsPool, V2Pool, V4Pool } from '../src/types';

const TRADER: Address = '0x2222222222222222222222222222222222222222';
const TOKEN: Address = '0x7507de4f2931b1dbc04d8ec8079849abdd74aaeb'; // AMC
const ANT: Address = '0xbbb6c29bcc3a1028a2b54310df73f4f7a3bcb373';
const CURVE: Address = '0x15b8a55f52705da788235a16e85e006717deb528';
const USDG = TRADE_ADDRESSES.usdg;
const WETH = TRADE_ADDRESSES.weth;

const curve: PonsPool = {
  venue: 'pons-curve', id: CURVE, curve: CURVE, token: TOKEN, quote: TRADE_ADDRESSES.eth,
  quoteReserve: 67n * 10n ** 18n, tokenReserve: 541_657_944n * 10n ** 18n, feeBps: 100, creatorTaxBps: 0,
  realQuoteReserve: 30n * 10n ** 18n, graduationThreshold: 91n * 10n ** 18n, sellableTokens: 255_943_658n * 10n ** 18n,
  snipeTaxBps: 0, graduated: false, nativeQuote: false, pairToken: ANT, venueFeeBps: 100, venueFeeLabel: 'PONS curve · 1.00% fee',
};
// ETH at $3,000 and ANT at $91, through USDG (v2 pools: pure math, no RPC).
const wethUsdg: V2Pool = { venue: 'uniswap-v2', id: '0x1000000000000000000000000000000000000001', token: USDG, quote: WETH, reserveToken: 3_000_000n * 10n ** 6n, reserveQuote: 1_000n * 10n ** 18n, venueFeeBps: 30, venueFeeLabel: 'Uniswap v2 · 0.30% pool fee' };
const usdgAnt: V2Pool = { venue: 'uniswap-v2', id: '0x1000000000000000000000000000000000000002', token: ANT, quote: USDG, reserveToken: 10_000n * 10n ** 18n, reserveQuote: 910_000n * 10n ** 6n, venueFeeBps: 30, venueFeeLabel: 'Uniswap v2 · 0.30% pool fee' };
const pairPools: PairPools = { pair: ANT, direct: [], pairUsdg: [usdgAnt], usdgEth: [wethUsdg] };

/** Gas price and the pair token's symbol/decimals are all that's read from the "chain". */
const fake = {
  getGasPrice: async () => 100_000_000n,
  readContract: async ({ functionName }: { functionName: string }) => (functionName === 'symbol' ? 'ANT' : functionName === 'decimals' ? 18 : 0n),
} as unknown as PublicClient;
const E = (x: number) => BigInt(Math.round(x * 1e6)) * 10n ** 12n;
const opts = (o: object = {}) => ({ discover: { pools: [curve] }, pairPools, simulate: false, acknowledgedHighRisk: true, assume: { ethWei: E(1), tokenWei: 10n ** 24n }, now: () => 1_000_000_000, ...o, config: { feeBps: 25, ...(o as { config?: object }).config } });
/** Decoded addresses come back checksummed; ours are lowercase. */
const low = (xs: readonly unknown[]): unknown[] => xs.map((x) => (typeof x === 'string' ? x.toLowerCase() : Array.isArray(x) ? low(x) : x));
const ur = (data: Hex) => decodeFunctionData({ abi: universalRouterAbi, data }).args as unknown as [Hex, Hex[], bigint];
const addrUintUint = (h: Hex) => decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], h);
const v2Input = (h: Hex) => decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address[]' }, { type: 'bool' }, { type: 'uint256[]' }], h);

describe('pair-token curves: buy with ETH', () => {
  it('approve the pair token for the curve, swap ETH → USDG → ANT with the fee in ETH, then buy on the curve', async () => {
    const t = await quickBuy(fake, { token: TOKEN, ethWei: E(0.01), trader: TRADER }, opts());
    expect(t.ok, JSON.stringify(t.blockers)).toBe(true);
    expect(t.calls.map((c) => c.label)).toEqual(['approve pair token for the curve', 'swap', 'curve swap']);
    expect(t.feeFollowUp).toBeNull();
    const legs = t.pairLegs!;
    expect(legs).toMatchObject({ side: 'buy', pairToken: ANT, pairSymbol: 'ANT', firstLeg: 1, secondLeg: 2, legSlippageBps: 200, feeBps: 25 });

    // approve(curve, max) on ANT
    expect(t.calls[0]!.to).toBe(ANT);
    expect(low(decodeFunctionData({ abi: erc20Abi, data: t.calls[0]!.data }).args)[0]).toBe(CURVE);

    // Universal Router: TRANSFER fee · WRAP_ETH · V2 (fixed) · V2 (CONTRACT_BALANCE) to the user
    const swap = t.calls[1]!;
    expect(swap).toMatchObject({ to: TRADE_ADDRESSES.universalRouter, value: E(0.01) });
    const [commands, inputs] = ur(swap.data);
    expect(commands).toBe('0x050b0808');
    expect(low(addrUintUint(inputs[0]!))).toEqual(['0x0000000000000000000000000000000000000000', RUSHR_TREASURY.toLowerCase(), E(0.000025)]);
    const net = E(0.01) - E(0.000025);
    const hop1 = v2Input(inputs[2]!);
    expect(low([hop1[0], hop1[1], hop1[2], hop1[3], hop1[4]])).toEqual([UR_ADDRESS_THIS, net, 0n, [WETH, USDG], false]);
    const hop2 = v2Input(inputs[3]!);
    const usdgOut = v2AmountOut(net, wethUsdg.reserveQuote, wethUsdg.reserveToken);
    const antOut = v2AmountOut(usdgOut, usdgAnt.reserveQuote, usdgAnt.reserveToken);
    expect(legs.pairAmount).toBe(antOut);
    expect(legs.minPairAmount).toBe((antOut * 9_800n) / 10_000n);
    expect(low([hop2[0], hop2[1], hop2[2], hop2[3], hop2[4]])).toEqual([UR_MSG_SENDER, CONTRACT_BALANCE, legs.minPairAmount, [USDG, ANT], false]);

    // curve.buy(guaranteed ANT, min tokens, user), no ETH attached
    const buy = decodeFunctionData({ abi: ponsCurveAbi, data: t.calls[2]!.data });
    expect(t.calls[2]).toMatchObject({ to: CURVE, value: 0n });
    expect(buy.functionName).toBe('buy');
    const minTokens = (ponsBuyCapped(legs.minPairAmount, curve).out * BigInt(10_000 - t.slippageBps)) / 10_000n;
    expect(low(buy.args)).toEqual([legs.minPairAmount, minTokens, TRADER]);
    expect(t.quote!.amountOut).toBe(ponsBuyCapped(antOut, curve).out);
    expect(t.quote!.minAmountOut).toBe(minTokens);
    expect(t.record).toMatchObject({ side: 'buy', venue: 'pons-curve', router: TRADE_ADDRESSES.universalRouter, feeBps: 25, feeAmount: E(0.000025) });
    // The later sell is pre-approved: token → curve, ANT → Permit2 → Universal Router.
    expect(t.sellApprovals.map((c) => c.label)).toEqual(['approve token for the curve', 'approve token for Permit2', 'allow Universal Router in Permit2']);
    expect(t.warnings.join(' ')).toContain('If the second fails you keep the ANT');
  });

  it('keeps the $RUSHR holder discount and stacks it with the referral discount', async () => {
    const h = await prepareQuickTrade(fake, { side: 'buy', token: TOKEN, amountIn: E(0.01), trader: TRADER, holderDiscountBps: 2_500 }, opts());
    expect(h.quote!.fee).toMatchObject({ feeBps: 18, holderDiscountBps: 2_500 }); // 25 − ceil(25 × 25%)
    expect(addrUintUint(ur(h.calls[1]!.data)[1][0]!)[2]).toBe((E(0.01) * 18n) / 10_000n);
    const both = await prepareQuickTrade(fake, { side: 'buy', token: TOKEN, amountIn: E(0.01), trader: TRADER, holderDiscountBps: 1_000, referral: { referrer: '0x3333333333333333333333333333333333333333' } }, opts());
    expect(both.quote!.fee.feeBps).toBe(20); // 25 − ceil(25 × 20%)
    expect(both.quote!.fee.referralDiscountAmount).toBeGreaterThan(0n);
  });

  it('no Uniswap route to the pair token, or a buy that would complete the curve: refused with a reason', async () => {
    const none = await quickBuy(fake, { token: TOKEN, ethWei: E(0.01), trader: TRADER }, opts({ pairPools: null }));
    expect(none.blockers[0]).toMatchObject({ code: 'NON_ETH_QUOTE', message: expect.stringContaining('priced in ANT') });
    const big = await quickBuy(fake, { token: TOKEN, ethWei: E(1), trader: TRADER }, opts({ discover: { pools: [{ ...curve, realQuoteReserve: 90n * 10n ** 18n }] }, settings: { maxTradeWei: E(10) } }));
    expect(big.blockers.map((b) => b.code)).toEqual(['CURVE_COMPLETES']);
  });
});

describe('pair-token curves: sell for ETH', () => {
  it('approvals first, then curve.sell → ANT, then ANT → USDG → ETH with PAY_PORTION and SWEEP to the user', async () => {
    const amount = 10n ** 23n;
    const t = await quickSell(fake, { token: TOKEN, trader: TRADER, amount }, opts());
    expect(t.ok, JSON.stringify(t.blockers)).toBe(true);
    expect(t.calls.map((c) => c.label)).toEqual(['approve token for the curve', 'approve token for Permit2', 'allow Universal Router in Permit2', 'curve swap', 'swap']);
    const legs = t.pairLegs!;
    expect(legs).toMatchObject({ side: 'sell', firstLeg: 3, secondLeg: 4 });
    expect(t.calls[1]!.to).toBe(ANT);
    const p2 = decodeFunctionData({ abi: permit2Abi, data: t.calls[2]!.data });
    expect(low(p2.args.slice(0, 2))).toEqual([ANT, TRADE_ADDRESSES.universalRouter]);

    const antOut = ponsSellOut(amount, curve.quoteReserve, curve.tokenReserve, curve.feeBps, curve.creatorTaxBps);
    const minAnt = (antOut * BigInt(10_000 - t.slippageBps)) / 10_000n;
    expect(low(decodeFunctionData({ abi: ponsCurveAbi, data: t.calls[3]!.data }).args)).toEqual([amount, minAnt, TRADER]);

    const [commands, inputs] = ur(t.calls[4]!.data);
    expect(commands).toBe('0x08080c0604'); // V2 (Permit2 pull) · V2 (CONTRACT_BALANCE) · UNWRAP_WETH · PAY_PORTION · SWEEP
    const hop1 = v2Input(inputs[0]!);
    expect(low([hop1[0], hop1[1], hop1[2], hop1[3], hop1[4]])).toEqual([UR_ADDRESS_THIS, minAnt, 0n, [ANT, USDG], true]);
    const hop2 = v2Input(inputs[1]!);
    expect(low([hop2[1], hop2[3], hop2[4]])).toEqual([CONTRACT_BALANCE, [USDG, WETH], false]);
    expect(low(addrUintUint(inputs[3]!))).toEqual(['0x0000000000000000000000000000000000000000', RUSHR_TREASURY.toLowerCase(), 25n]);
    const [sweepToken, sweepTo, minNet] = addrUintUint(inputs[4]!);
    expect(low([sweepToken, sweepTo, minNet])).toEqual(['0x0000000000000000000000000000000000000000', UR_MSG_SENDER, t.quote!.minAmountOut]);

    const gross = v2AmountOut(v2AmountOut(antOut, usdgAnt.reserveToken, usdgAnt.reserveQuote), wethUsdg.reserveToken, wethUsdg.reserveQuote);
    expect(t.quote!.grossOut).toBe(gross);
    expect(t.quote!.fee.feeAmount).toBe((gross * 25n) / 10_000n);
    expect(t.quote!.amountOut).toBe(gross - t.quote!.fee.feeAmount);
  });
});

describe('finishing and explaining a pair trade', () => {
  const transfer = (token: Address, to: Address, value: bigint) => ({
    address: token,
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', pad('0x1000000000000000000000000000000000000002'), pad(to)] as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
  });

  it('rebuilds the second leg from what arrived, capped by the balance (stock tokens log scaled amounts)', async () => {
    const t = await quickBuy(fake, { token: TOKEN, ethWei: E(0.01), trader: TRADER }, opts());
    const legs = t.pairLegs!;
    const arrived = legs.pairAmount - 1_000n;
    const receipt = { logs: [transfer(ANT, TRADER, arrived), transfer(ANT, '0x9999999999999999999999999999999999999999', 5n)] };
    expect(pairReceived(legs, receipt)).toBe(arrived);
    // The balance says a little less arrived than the log: use the balance.
    expect(pairReceived(legs, receipt, arrived - 37n)).toBe(arrived - 37n);
    const second = finalizePairLeg(t, receipt, { balanceAfter: arrived - 37n })!;
    expect(second).toMatchObject({ label: 'curve swap', to: CURVE, value: 0n });
    const args = decodeFunctionData({ abi: ponsCurveAbi, data: second.data }).args;
    expect(args[0]).toBe(arrived - 37n);
    expect(args[1]).toBe((ponsBuyCapped(arrived - 37n, curve).out * BigInt(10_000 - t.slippageBps)) / 10_000n);
    expect(finalizePairLeg(t, { logs: [] })).toBeNull();

    const s = await quickSell(fake, { token: TOKEN, trader: TRADER, amount: 10n ** 23n }, opts());
    const sl = s.pairLegs!;
    const fromCurve = sl.pairAmount + 10n ** 12n; // the curve paid a bit more than the minimum, as usual
    const rebuilt = finalizePairLeg(s, { logs: [transfer(ANT, TRADER, fromCurve)] }, { nowS: 2_000_000_000 })!;
    const [, inputs, deadline] = ur(rebuilt.data);
    expect(deadline).toBe(2_000_000_300n);
    expect(v2Input(inputs[0]!)[1]).toBe(fromCurve);
    const minGross = (((sl.ethGross * fromCurve) / sl.pairAmount) * 9_800n) / 10_000n;
    expect(v2Input(inputs[1]!)[2]).toBe(minGross);
  });

  it('says what the user holds when the second leg fails', () => {
    expect(pairHeldMessage({ pairSymbol: 'ANT', pairDecimals: 18 }, 10n ** 17n)).toBe('You now hold 0.1 ANT; retry or sell it.');
    expect(formatPairAmount(1_234_567_890_000_000_000n, 18, 'ANT')).toBe('1.234567 ANT');
    expect(formatPairAmount(5_000_000n, 6, 'USDG')).toBe('5 USDG');
  });
});

describe('pair route plan', () => {
  const v4Native: V4Pool = {
    venue: 'uniswap-v4', id: '0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e', token: USDG, quote: TRADE_ADDRESSES.eth,
    key: { currency0: TRADE_ADDRESSES.eth, currency1: USDG, fee: 100, tickSpacing: 1, hooks: TRADE_ADDRESSES.eth }, hookData: '0x', venueFeeBps: 1, venueFeeLabel: 'Uniswap v4 · 0.01% pool fee',
  };
  it('v4 native-ETH first hop: swap the fixed amount, settle from msg.value, keep USDG in the router; no WRAP_ETH', () => {
    const c = planPairSwap({ side: 'buy', hops: [{ pool: v4Native, tokenIn: TRADE_ADDRESSES.eth, tokenOut: USDG }, { pool: usdgAnt, tokenIn: USDG, tokenOut: ANT }], amountIn: 1000n, minOut: 7n, treasury: RUSHR_TREASURY, feeAmount: 3n });
    expect(c.map((x) => x.label)).toEqual(['TRANSFER', 'V4_SWAP(SWAP_EXACT_IN_SINGLE,SETTLE,TAKE)', 'V2_SWAP_EXACT_IN']);
  });
  it('v4 second hop on a sell: settle the router balance, swap the open credit, take ETH to the router', () => {
    const c = planPairSwap({ side: 'sell', hops: [{ pool: usdgAnt, tokenIn: ANT, tokenOut: USDG }, { pool: v4Native, tokenIn: USDG, tokenOut: TRADE_ADDRESSES.eth }], amountIn: 1000n, minOut: 7n, treasury: RUSHR_TREASURY, feeBps: 25, minNet: 6n });
    expect(c.map((x) => x.label)).toEqual(['V2_SWAP_EXACT_IN', 'V4_SWAP(SETTLE,SWAP_EXACT_IN_SINGLE,TAKE)', 'PAY_PORTION', 'SWEEP']);
  });
  it('combined impact of a path', () => {
    expect(pathImpactBps([{ spotOut: 100n, out: 99n, venueFeeBps: 0 }, { spotOut: 100n, out: 99n, venueFeeBps: 0 }])).toBe(199);
    expect(pathImpactBps([{ spotOut: null, out: 1n, venueFeeBps: 0 }])).toBeNull();
  });
});

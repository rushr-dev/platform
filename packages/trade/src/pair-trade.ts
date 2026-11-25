import { encodeFunctionData, maxUint256, type Address, type Hex, type PublicClient } from 'viem';
import { erc20Abi, ponsCurveAbi } from './abis';
import type { TradeConfig } from './config';
import { isTradeError, sanitizeRpcMessage } from './errors';
import { feeOf, minOut, splitBuyInput, splitSellOutput, type FeeBreakdown } from './fees';
import { ponsBuyCapped, ponsSellOut } from './math';
import { readAllowances } from './permit2';
import { discoverPools } from './pools';
import { cashbackOf, effectiveFeeBps, referrerAccrual, savedBetween, draftTradeRecord } from './referral';
import { simulateCalls, type SimCall } from './simulate';
import { encodeExecute } from './universal-router';
import {
  discoverPairPools,
  formatPairAmount,
  netTokenIn,
  pairTokenMeta,
  pathImpactBps,
  pathLabel,
  planPairSwap,
  quoteEthToPair,
  quotePairToEth,
  type PairDiscoverOptions,
  type PairHop,
  type PairPools,
} from './pair-route';
import {
  autoSlippageBps,
  CURVE_GAS,
  CURVE_GRADUATED_MESSAGE,
  evaluateGuards,
  quickApprovalCalls,
  type Guard,
  type QuickSettings,
  type QuickTrade,
  type QuickTradeOptions,
  type QuickTradeRequest,
  type WalletCall,
} from './quick';
import type { PonsPool, Quote } from './types';

/**
 * Trades on a PONS curve priced in another ERC-20 (the "pair token", e.g. AMC priced in ANT), paid and
 * received in ETH. No Rushr contract: two ordinary trades from the user's wallet, both audited code.
 *
 *   buy:  [approve pair -> curve] · Universal Router: fee in ETH, ETH -> (USDG) -> pair to the user
 *         · curve.buy(pairIn, minTokensOut, user)
 *   sell: [approve token -> curve] · [pair -> Permit2] · [Permit2 -> Universal Router]
 *         · curve.sell(tokensIn, minPairOut, user) · Universal Router: pair -> (USDG) -> ETH, fee, rest to the user
 *
 * Approvals go first, so the only point where the trade can stop half way is between the two trading
 * legs. If the second leg fails, the user is left holding the pair token (never a loss: it is in their
 * wallet, worth what the first leg paid); the app says so and offers to retry or sell it.
 *
 * The second leg is built against the GUARANTEED minimum of the first (it can't spend more than surely
 * arrived). An app that waits for the first receipt should rebuild it from the amount that actually
 * arrived (`finalizePairLeg`), so nothing is left over; sent as built, the surplus (at most the first
 * leg's slippage) stays in the wallet as pair token.
 */

/** Slippage on the Universal Router leg of a pair route (liquid pools, quoted seconds before): at most this. */
export const PAIR_LEG_SLIPPAGE_BPS = 200;
const SWAP_GAS = 600_000n;

/** What a two-leg pair trade carries so the app can finish, rebuild or explain it. */
export interface PairLegs {
  kind: 'pair-curve';
  side: 'buy' | 'sell';
  token: Address;
  trader: Address;
  pairToken: Address;
  pairSymbol: string;
  pairDecimals: number;
  /** Universal Router path, e.g. "Uniswap v4 · 0.01% pool fee → Uniswap v3 · 0.05% pool fee". */
  path: string;
  hops: PairHop[];
  curve: PonsPool;
  /** Pair token expected between the legs, and the guaranteed minimum the second leg spends as built. */
  pairAmount: bigint;
  minPairAmount: bigint;
  /** Indices into `calls`: the first trading leg and the second. */
  firstLeg: number;
  secondLeg: number;
  slippageBps: number;
  legSlippageBps: number;
  feeBps: number;
  treasury: Address;
  universalRouter: Address;
  /** Sells: gross ETH quoted for `pairAmount` (the second leg's minimum scales from it). */
  ethGross: bigint;
  /** The trader's pair-token balance when quoted (null if unknown): what arrived = balance after − this. */
  pairBalanceBefore: bigint | null;
  /** Unix seconds: the Universal Router leg's deadline as built. */
  deadline: bigint;
}

type Empty = (b: Guard[], w?: string[]) => QuickTrade;

/** Pair-route options read from QuickTradeOptions (kept apart so the curve path needs no change). */
export interface PairTradeOptions {
  /** API pool rows per token for the pair-route discovery (web: fetchApiPools; indexer: its own index). */
  pairApiPools?: PairDiscoverOptions['apiPools'];
  /** Pools already discovered for the pair route (tests). */
  pairPools?: PairPools | null;
}

export async function preparePairCurveTrade(
  client: PublicClient,
  req: QuickTradeRequest,
  curve: PonsPool,
  opts: QuickTradeOptions,
  settings: QuickSettings,
  cfg: TradeConfig,
  now: number,
  empty: Empty,
): Promise<QuickTrade> {
  const pair = curve.pairToken;
  if (!pair) return empty([{ code: 'NON_ETH_QUOTE', message: 'This bonding curve is priced in another token we could not identify; not tradable from ETH.' }]);
  if (req.side === 'buy' && curve.snipeTaxBps > 0)
    return empty([{ code: 'SNIPE_TAX_ACTIVE', message: `Launch snipe tax is ${(curve.snipeTaxBps / 100).toFixed(0)}% right now; it drops to 0 within seconds of launch. Try again in a moment.` }]);
  const nowS = Math.floor(now / 1000);
  const holderBps = req.holderDiscountBps ?? 0;
  const feeBps = effectiveFeeBps(cfg, req.referral, holderBps);
  const holderOnlyBps = effectiveFeeBps(cfg, null, holderBps);

  const pp = opts.pairPools !== undefined ? opts.pairPools : await discoverPairPools(client, pair, { apiPools: opts.pairApiPools });
  const meta = await pairTokenMeta(client, pair);
  if (!pp) return empty([{ code: 'NON_ETH_QUOTE', message: `This bonding curve is priced in ${meta.symbol}, and there is no Uniswap route from ETH to ${meta.symbol}.` }]);

  // Chain facts, fetched while the route quotes.
  const assumed = !!opts.assume;
  const facts = Promise.all([
    opts.assume?.ethWei ?? client.getBalance({ address: req.trader }),
    req.side === 'sell' ? (opts.assume?.tokenWei ?? client.readContract({ address: req.token, abi: erc20Abi, functionName: 'balanceOf', args: [req.trader] })) : Promise.resolve(0n),
    client.getGasPrice().catch(() => 100_000_000n),
    // token -> curve (sells now; buys pre-approve for the later sell), pair -> curve (buys), pair via Permit2 (sells).
    assumed ? Promise.resolve(0n) : client.readContract({ address: req.token, abi: erc20Abi, functionName: 'allowance', args: [req.trader, curve.curve] }).catch(() => null),
    assumed || req.side === 'sell' ? Promise.resolve(0n) : client.readContract({ address: pair, abi: erc20Abi, functionName: 'allowance', args: [req.trader, curve.curve] }).catch(() => 0n),
    assumed ? Promise.resolve({ erc20ToPermit2: 0n, permit2Amount: 0n, permit2Expiration: 0, permit2Nonce: 0 }) : readAllowances(client, req.trader, pair, cfg.universalRouter).catch(() => null),
    assumed ? Promise.resolve(0n) : client.readContract({ address: pair, abi: erc20Abi, functionName: 'balanceOf', args: [req.trader] }).catch(() => null),
  ] as const);
  const settle = <T>(r: T) => (void facts.catch(() => undefined), r);

  const tax = req.side === 'buy' ? opts.risk?.buyTaxBps : opts.risk?.sellTaxBps;
  const fee = (amount: bigint, basis: bigint): FeeBreakdown => ({
    side: req.side,
    feeToken: '0x0000000000000000000000000000000000000000',
    feeBps,
    baseFeeBps: cfg.feeBps,
    feeAmount: amount,
    holderDiscountBps: holderBps,
    holderDiscountAmount: holderBps ? savedBetween(basis, cfg.feeBps, holderOnlyBps) : 0n,
    referralDiscountAmount: req.referral ? savedBetween(basis, holderOnlyBps, feeBps) : 0n,
    referrerAccrual: referrerAccrual(amount, cfg, req.referral),
    cashbackAmount: cashbackOf(amount, cfg),
    venueFeeBps: curve.venueFeeBps,
    venueFeeLabel: curve.venueFeeLabel,
  });
  const base = { side: req.side, token: req.token, quoteAsset: 'ETH' as const, amountIn: req.amountIn, trader: req.trader, referral: req.referral ?? null, holderDiscountBps: holderBps, source: { kind: 'web' as const } };
  const curveCall = (data: Hex, gas: bigint): WalletCall => ({ label: 'curve swap', chainId: 4663, to: curve.curve, value: 0n, gas, data });
  const approve = (token: Address, label: WalletCall['label']): WalletCall => ({
    label,
    chainId: 4663,
    to: token,
    value: 0n,
    gas: CURVE_GAS.approve,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [curve.curve, maxUint256] }),
  });
  const warnings: string[] = [];
  let quote: Quote;
  let calls: WalletCall[];
  let sellApprovals: WalletCall[] = [];
  let legs: PairLegs;
  let hops: PairHop[] | null;
  let slippageBps: number;

  try {
    if (req.side === 'buy') {
      const { fee: feeAmount, swapAmount } = splitBuyInput(req.amountIn, feeBps);
      hops = await quoteEthToPair(client, pp, swapAmount);
      if (!hops) return settle(empty([{ code: 'NO_ROUTE', message: `No Uniswap pool quotes ETH to ${meta.symbol} for this amount.` }]));
      const pairOut = hops[hops.length - 1]!.amountOut;
      const c = ponsBuyCapped(pairOut, curve);
      if (c.capped) return settle(empty([{ code: 'CURVE_COMPLETES', message: 'This buy would complete the bonding curve. Try a smaller amount.' }]));
      const spot = curve.quoteReserve > 0n ? (pairOut * curve.tokenReserve) / curve.quoteReserve : null;
      const impact = pathImpactBps([...hops.map((h) => ({ spotOut: h.spotOut, out: h.amountOut, venueFeeBps: h.pool.venueFeeBps })), { spotOut: spot, out: c.out, venueFeeBps: curve.venueFeeBps }]);
      slippageBps = settings.slippageBps ?? autoSlippageBps({ side: 'buy', ageMinutes: opts.risk?.ageMinutes, priceChange5mPct: opts.risk?.priceChange5mPct, priceImpactBps: impact, taxBps: tax });
      const legS = Math.min(slippageBps, PAIR_LEG_SLIPPAGE_BPS);
      const minPair = minOut(pairOut, legS);
      const minTokens = minOut(ponsBuyCapped(minPair, curve).out, slippageBps);
      if (impact !== null && impact > 500) warnings.push(`High price impact: ${(impact / 100).toFixed(1)}%`);
      quote = {
        request: { ...base, slippageBps },
        pool: curve,
        amountIn: req.amountIn,
        swapAmountIn: swapAmount,
        grossOut: c.out,
        amountOut: c.out,
        minAmountOut: minTokens,
        minGrossOut: minTokens,
        slippageBps,
        fee: fee(feeAmount, req.amountIn),
        priceImpactBps: impact,
        gasEstimate: null,
        expectedRefund: 0n,
        warnings,
      };
      const commands = planPairSwap({ side: 'buy', hops, amountIn: swapAmount, minOut: minPair, treasury: cfg.feeRecipient, feeAmount });
      const [, , , tokenAllowance, pairAllowance, pairPermit, pairBalanceBefore] = await facts;
      calls = [];
      if ((pairAllowance ?? 0n) < pairOut) calls.push(approve(pair, 'approve pair token for the curve'));
      const firstLeg = calls.length;
      calls.push({ label: 'swap', chainId: 4663, to: cfg.universalRouter, value: req.amountIn, gas: SWAP_GAS, data: encodeExecute(commands, BigInt(nowS + cfg.deadlineSeconds)) });
      calls.push(curveCall(encodeFunctionData({ abi: ponsCurveAbi, functionName: 'buy', args: [minPair, minTokens, req.trader] }), CURVE_GAS.buy));
      // After the buy: approvals the later sell needs, so it is two transactions (curve, then swap).
      if (tokenAllowance !== null && tokenAllowance < 1n << 128n) sellApprovals.push(approve(req.token, 'approve token for the curve'));
      if (pairPermit) sellApprovals.push(...quickApprovalCalls(pair, pairPermit, 1n << 128n, nowS, cfg));
      legs = { kind: 'pair-curve', side: 'buy', token: req.token, trader: req.trader, pairToken: pair, pairSymbol: meta.symbol, pairDecimals: meta.decimals, path: pathLabel(hops), hops, curve, pairAmount: pairOut, minPairAmount: minPair, firstLeg, secondLeg: firstLeg + 1, slippageBps, legSlippageBps: legS, feeBps, treasury: cfg.feeRecipient, universalRouter: cfg.universalRouter, ethGross: 0n, pairBalanceBefore, deadline: BigInt(nowS + cfg.deadlineSeconds) };
    } else {
      const pairOut = ponsSellOut(req.amountIn, curve.quoteReserve, curve.tokenReserve, curve.feeBps, curve.creatorTaxBps);
      if (pairOut <= 0n) return settle(empty([{ code: 'NO_ROUTE', message: 'The curve returns nothing for this amount.' }]));
      hops = await quotePairToEth(client, pp, pairOut);
      if (!hops) return settle(empty([{ code: 'NO_ROUTE', message: `No Uniswap pool quotes ${meta.symbol} to ETH for this amount.` }]));
      const ethGross = hops[hops.length - 1]!.amountOut;
      const spot = curve.tokenReserve > 0n ? (req.amountIn * curve.quoteReserve) / curve.tokenReserve : null;
      const impact = pathImpactBps([{ spotOut: spot, out: pairOut, venueFeeBps: curve.venueFeeBps }, ...hops.map((h) => ({ spotOut: h.spotOut, out: h.amountOut, venueFeeBps: h.pool.venueFeeBps }))]);
      slippageBps = settings.slippageBps ?? autoSlippageBps({ side: 'sell', ageMinutes: opts.risk?.ageMinutes, priceChange5mPct: opts.risk?.priceChange5mPct, priceImpactBps: impact, taxBps: tax });
      const legS = Math.min(slippageBps, PAIR_LEG_SLIPPAGE_BPS);
      const minPair = minOut(pairOut, slippageBps);
      // The swap leg as built spends the guaranteed minimum; its ETH minimum scales with it.
      const minGross = minOut((ethGross * minPair) / pairOut, legS);
      const { netOut: minNet } = splitSellOutput(minGross, feeBps);
      const { fee: feeAmount, netOut } = splitSellOutput(ethGross, feeBps);
      if (impact !== null && impact > 500) warnings.push(`High price impact: ${(impact / 100).toFixed(1)}%`);
      quote = {
        request: { ...base, slippageBps },
        pool: curve,
        amountIn: req.amountIn,
        swapAmountIn: req.amountIn,
        grossOut: ethGross,
        amountOut: netOut,
        minAmountOut: minNet,
        minGrossOut: minGross,
        slippageBps,
        fee: fee(feeAmount, ethGross),
        priceImpactBps: impact,
        gasEstimate: null,
        expectedRefund: 0n,
        warnings,
      };
      const commands = planPairSwap({ side: 'sell', hops, amountIn: minPair, minOut: minGross, treasury: cfg.feeRecipient, feeBps, minNet });
      const [, , , tokenAllowance, , pairPermit, pairBalanceBefore] = await facts;
      calls = [];
      if ((tokenAllowance ?? 0n) < req.amountIn) calls.push(approve(req.token, 'approve token for the curve'));
      calls.push(...quickApprovalCalls(pair, pairPermit ?? { erc20ToPermit2: 0n, permit2Amount: 0n, permit2Expiration: 0 }, pairOut, nowS, cfg));
      const firstLeg = calls.length;
      calls.push(curveCall(encodeFunctionData({ abi: ponsCurveAbi, functionName: 'sell', args: [req.amountIn, minPair, req.trader] }), CURVE_GAS.sell));
      calls.push({ label: 'swap', chainId: 4663, to: cfg.universalRouter, value: 0n, gas: SWAP_GAS, data: encodeExecute(commands, BigInt(nowS + cfg.deadlineSeconds)) });
      legs = { kind: 'pair-curve', side: 'sell', token: req.token, trader: req.trader, pairToken: pair, pairSymbol: meta.symbol, pairDecimals: meta.decimals, path: pathLabel(hops), hops, curve, pairAmount: pairOut, minPairAmount: minPair, firstLeg, secondLeg: firstLeg + 1, slippageBps, legSlippageBps: legS, feeBps, treasury: cfg.feeRecipient, universalRouter: cfg.universalRouter, ethGross, pairBalanceBefore, deadline: BigInt(nowS + cfg.deadlineSeconds) };
    }
  } catch (e) {
    return settle(empty([{ code: 'NO_ROUTE', message: isTradeError(e) ? e.message : sanitizeRpcMessage(e) }]));
  }

  const [ethBal, tokenBal, gasPrice] = await facts;
  warnings.push(
    req.side === 'buy'
      ? `Two trades: ETH → ${meta.symbol} on Uniswap (${legs.path}), then ${meta.symbol} → token on the bonding curve. If the second fails you keep the ${meta.symbol}.`
      : `Two trades: token → ${meta.symbol} on the bonding curve, then ${meta.symbol} → ETH on Uniswap (${legs.path}). If the second fails you keep the ${meta.symbol}.`,
  );
  const gasCostWei = calls.reduce((s, c) => s + c.gas, 0n) * gasPrice * 2n;
  const g = evaluateGuards({ quote, settings, risk: opts.risk, acknowledgedHighRisk: !!opts.acknowledgedHighRisk, ethBalanceWei: ethBal, tokenBalanceWei: tokenBal, gasCostWei });
  const blockers = g.blockers;
  const allWarnings = [...g.warnings.filter((w) => !quote.warnings.includes(w)), ...quote.warnings];

  if (!blockers.length && opts.simulate !== false) {
    const simCalls: SimCall[] = calls.map((c) => ({ from: req.trader, to: c.to, data: c.data, value: c.value, label: c.label }));
    try {
      const sim = await simulateCalls(client, simCalls, opts.assume?.ethWei ? { fund: { [req.trader]: opts.assume.ethWei } } : {});
      const bad = sim.calls.find((c) => !c.ok);
      if (bad && /CurveGraduated/.test(bad.error ?? '')) blockers.push({ code: 'CURVE_GRADUATED', message: CURVE_GRADUATED_MESSAGE });
      else if (bad) blockers.push({ code: 'SIMULATION_REVERTED', message: `Would fail on-chain (${bad.label}): ${bad.error}` });
      else calls.forEach((c, i) => (c.gas = maxBig(c.gas, (sim.calls[i]!.gasUsed * 13n) / 10n + 20_000n)));
    } catch (e) {
      allWarnings.push(`Pre-send simulation unavailable: ${isTradeError(e) ? e.message : sanitizeRpcMessage(e)}`);
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings: allWarnings,
    quote,
    alternatives: [],
    calls,
    sellApprovals,
    slippageBps,
    gasCostWei,
    quotedAt: now,
    expiresAt: now + settings.quoteMaxAgeMs,
    record: draftTradeRecord(quote, cfg, cfg.universalRouter, nowS),
    feeFollowUp: null,
    pairLegs: legs,
    unwrapAfter: null,
  };
}

const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);

/**
 * Pair token that reached the trader in the first leg. Robinhood stock tokens (ANT, ...) keep balances in
 * scaled units, so their Transfer logs can overstate the balance by a few parts per million: when the
 * balance right after the leg is known, what arrived is capped by it (minus the balance before, when that
 * is known too), so the second leg never spends more than the wallet holds.
 */
export function pairReceived(
  legs: Pick<PairLegs, 'pairToken' | 'trader'> & { pairBalanceBefore?: bigint | null },
  receipt: { logs: readonly { address: string; topics: readonly string[]; data: string }[] },
  balanceAfter?: bigint | null,
): bigint {
  let n = netTokenIn(receipt.logs, legs.pairToken, legs.trader);
  if (balanceAfter != null) {
    const delta = legs.pairBalanceBefore != null ? balanceAfter - legs.pairBalanceBefore : balanceAfter;
    if (delta < n) n = delta;
  }
  return n > 0n ? n : 0n;
}

/**
 * The second leg rebuilt for the pair token that actually arrived in the first leg (its receipt, capped by
 * the trader's pair-token balance read right after it), so nothing is left over. Same minimum rules as the
 * build: the curve leg keeps the trade's slippage, the swap leg's ETH minimum scales with the amount. Null
 * when nothing arrived. `nowS` sets a fresh Universal Router deadline.
 */
export function finalizePairLeg(
  t: Pick<QuickTrade, 'calls' | 'pairLegs'>,
  receipt: { logs: readonly { address: string; topics: readonly string[]; data: string }[] },
  opts: { balanceAfter?: bigint | null; nowS?: number; deadlineSeconds?: number } = {},
): WalletCall | null {
  const legs = t.pairLegs;
  if (!legs) return null;
  const got = pairReceived(legs, receipt, opts.balanceAfter);
  if (got <= 0n) return null;
  return { ...t.calls[legs.secondLeg]!, data: secondLegData(legs, got, (opts.nowS ?? Math.floor(Date.now() / 1000)) + (opts.deadlineSeconds ?? 300)) };
}

function secondLegData(legs: PairLegs, pairIn: bigint, deadline: number): Hex {
  if (legs.side === 'buy') {
    const c = ponsBuyCapped(pairIn, legs.curve);
    return encodeFunctionData({ abi: ponsCurveAbi, functionName: 'buy', args: [pairIn, minOut(c.out, legs.slippageBps), legs.trader] });
  }
  const minGross = minOut(legs.pairAmount > 0n ? (legs.ethGross * pairIn) / legs.pairAmount : 0n, legs.legSlippageBps);
  const commands = planPairSwap({ side: 'sell', hops: legs.hops, amountIn: pairIn, minOut: minGross, treasury: legs.treasury, feeBps: legs.feeBps, minNet: splitSellOutput(minGross, legs.feeBps).netOut });
  return encodeExecute(commands, BigInt(deadline));
}

/** "You now hold 0.1 ANT; retry or sell it." for a trade stopped between its legs. */
export function pairHeldMessage(legs: Pick<PairLegs, 'pairSymbol' | 'pairDecimals'>, held: bigint): string {
  return `You now hold ${formatPairAmount(held, legs.pairDecimals, legs.pairSymbol)}; retry or sell it.`;
}

/**
 * What to do with pair token left in the wallet by a pair trade that stopped between its legs, from fresh
 * chain state, simulated from the trader:
 * - 'finish': complete the trade. Buys put `held` into the curve (no Rushr fee: it was paid in the first
 *   leg); sells swap `held` to ETH with the trade's fee (the leg that failed carried it, so it was never paid).
 * - 'unwind' (buys only): swap `held` back to ETH with no Rushr fee, for a user who'd rather not retry.
 */
export async function preparePairRetry(
  client: PublicClient,
  legs: PairLegs,
  held: bigint,
  opts: { action?: 'finish' | 'unwind'; simulate?: boolean; now?: number; deadlineSeconds?: number; pairApiPools?: PairDiscoverOptions['apiPools'] } = {},
): Promise<{ ok: boolean; call: WalletCall | null; expectedOut: bigint; message: string | null }> {
  const nowS = Math.floor((opts.now ?? Date.now()) / 1000);
  const deadline = nowS + (opts.deadlineSeconds ?? 300);
  const action = legs.side === 'buy' ? (opts.action ?? 'finish') : 'finish';
  let call: WalletCall;
  let expectedOut: bigint;
  if (held <= 0n) return { ok: false, call: null, expectedOut: 0n, message: `No ${legs.pairSymbol} to use.` };
  if (legs.side === 'buy' && action === 'finish') {
    const pools = await discoverPools(client, legs.token, { quoteAsset: 'ETH', venues: ['pons-curve'], trader: legs.trader });
    const curve = pools.find((p): p is PonsPool => p.venue === 'pons-curve' && !p.graduated);
    if (!curve) return { ok: false, call: null, expectedOut: 0n, message: `The curve has graduated; sell the ${legs.pairSymbol} instead.` };
    const c = ponsBuyCapped(held, curve);
    if (c.capped) return { ok: false, call: null, expectedOut: 0n, message: `This would complete the bonding curve; sell the ${legs.pairSymbol} instead.` };
    expectedOut = c.out;
    call = { label: 'curve swap', chainId: 4663, to: curve.curve, value: 0n, gas: CURVE_GAS.buy, data: encodeFunctionData({ abi: ponsCurveAbi, functionName: 'buy', args: [held, minOut(c.out, legs.slippageBps), legs.trader] }) };
  } else {
    const feeBps = action === 'unwind' ? 0 : legs.feeBps;
    const pp = await discoverPairPools(client, legs.pairToken, { apiPools: opts.pairApiPools });
    const hops = pp ? await quotePairToEth(client, pp, held) : null;
    if (!hops) return { ok: false, call: null, expectedOut: 0n, message: `No route from ${legs.pairSymbol} to ETH right now.` };
    const gross = hops[hops.length - 1]!.amountOut;
    const minGross = minOut(gross, legs.legSlippageBps);
    expectedOut = gross - feeOf(gross, feeBps);
    const commands = planPairSwap({ side: 'sell', hops, amountIn: held, minOut: minGross, treasury: legs.treasury, feeBps, minNet: splitSellOutput(minGross, feeBps).netOut });
    call = { label: 'swap', chainId: 4663, to: legs.universalRouter, value: 0n, gas: SWAP_GAS, data: encodeExecute(commands, BigInt(deadline)) };
  }
  if (opts.simulate !== false) {
    const sim = await simulateCalls(client, [{ from: legs.trader, to: call.to, data: call.data, value: call.value, label: call.label }]).catch(() => null);
    const r = sim?.calls[0];
    if (r && !r.ok) return { ok: false, call, expectedOut, message: `Would fail on-chain: ${r.error}` };
    if (r) call.gas = maxBig(call.gas, (r.gasUsed * 13n) / 10n + 20_000n);
  }
  return { ok: true, call, expectedOut, message: null };
}

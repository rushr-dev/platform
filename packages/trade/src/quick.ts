import { encodeFunctionData, maxUint256, type Address, type Hex, type PublicClient } from 'viem';
import { TRADE_ADDRESSES } from './addresses';
import { erc20Abi, permit2Abi, ponsCurveAbi } from './abis';
import { buildSwap } from './build';
import { BETA_FEE_BPS, resolveConfig, STANDARD_FEE_BPS, type TradeConfig } from './config';
import { TradeError, isTradeError, sanitizeRpcMessage } from './errors';
import { readAllowances } from './permit2';
import { discoverPools, type DiscoverOptions } from './pools';
import { quotePool, rankQuotes, withSlippage } from './quote';
import { draftTradeRecord, type TradeRecord } from './referral';
import { simulateCalls, type SimCall } from './simulate';
import type { PonsPool, Pool, Quote, Referral } from './types';
import type { ApiPoolRow } from './api-pools';
import { STOCK_QUOTES } from '@rushr/core/chain/robinhood';

/**
 * Beta trading v0: quick buy / sell signed client-side by the user's Privy embedded wallet with its UI
 * hidden (no popup). Everything goes through Uniswap's audited Universal Router with the Rushr fee in
 * the same tx; recipient is always the user (MSG_SENDER / SWEEP to the user). No Rushr contract, no
 * server key. PONS curve tokens are "tradable after graduation".
 *
 * This module only BUILDS and CHECKS. The web app passes `calls` to the embedded wallet in order.
 */

export const EXPLORER = 'https://robinhoodchain.blockscout.com';
export const explorerTxUrl = (hash: Hex) => `${EXPLORER}/tx/${hash}`;

export interface QuickSettings {
  /** Per-trade cap on the ETH side (buy input / expected sell output). Default 0.25 ETH; user-adjustable. */
  maxTradeWei: bigint;
  /** Fixed slippage, or null for automatic (5–15% depending on volatility, plus measured tax). */
  slippageBps: number | null;
  /** A quote older than this must be refreshed before sending. */
  quoteMaxAgeMs: number;
}

/** Pools charging more than this are never routed (stray/trap pools, e.g. a 89% fee v4 pool). */
export const MAX_VENUE_FEE_BPS = 1_000;
/** Warn above this venue fee. */
export const WARN_VENUE_FEE_BPS = 300;
/** Hard block above this price impact. */
export const MAX_IMPACT_BPS = 3_000;

export const DEFAULT_QUICK_SETTINGS: QuickSettings = { maxTradeWei: 250_000_000_000_000_000n, slippageBps: null, quoteMaxAgeMs: 10_000 };

/** What the app knows about the token's risk (Rushr API signals + optional buy→sell probe). */
export interface TokenRiskInfo {
  risk?: 'low' | 'medium' | 'high' | 'unknown' | null;
  verdict?: string | null;
  /** From the simulated buy→sell probe. */
  honeypot?: boolean;
  buyTaxBps?: number | null;
  sellTaxBps?: number | null;
  ageMinutes?: number | null;
  /** |price change| over ~5 minutes, in percent, if known. */
  priceChange5mPct?: number | null;
}

export type GuardCode =
  | 'CURVE_NOT_GRADUATED'
  | 'SNIPE_TAX_ACTIVE'
  | 'CURVE_GRADUATED'
  | 'NO_ROUTE'
  | 'LIQUIDITY_REMOVED'
  | 'NON_ETH_QUOTE'
  | 'OVER_CAP'
  | 'RISK_ACK_REQUIRED'
  | 'HONEYPOT'
  | 'INSUFFICIENT_ETH'
  | 'INSUFFICIENT_TOKEN'
  | 'SIMULATION_REVERTED'
  | 'HIGH_IMPACT';

export interface Guard {
  code: GuardCode;
  message: string;
}

const QUOTE_NAMES: Record<string, string> = {
  [TRADE_ADDRESSES.usdg.toLowerCase()]: 'USDG',
  ...Object.fromEntries(Object.entries(STOCK_QUOTES).map(([sym, a]) => [a.toLowerCase(), sym])),
};

/**
 * The token only trades against another asset (Doppler pairs many launches with USDG or a stock token).
 * Routing ETH through that asset (multi-hop) isn't built yet, so say so instead of "no pool".
 */
export function nonEthQuoteGuard(rows: ApiPoolRow[] | null | undefined): Guard | null {
  const eth = new Set([TRADE_ADDRESSES.eth.toLowerCase(), TRADE_ADDRESSES.weth.toLowerCase()]);
  const other = (rows ?? []).map((r) => r.quote?.toLowerCase()).filter((q): q is string => !!q && !eth.has(q));
  if (!other.length) return null;
  const name = QUOTE_NAMES[other[0]!] ?? 'another token';
  return { code: 'NON_ETH_QUOTE', message: `This token trades against ${name}, not ETH. Buying with ETH through ${name} isn't supported yet.` };
}

/**
 * Automatic slippage: 5% base, more for young or volatile tokens and high impact, capped at 15%, plus
 * the token's measured transfer tax on top (a 10% tax needs 10% more room or the trade reverts).
 */
export function autoSlippageBps(p: { side: 'buy' | 'sell'; ageMinutes?: number | null; priceChange5mPct?: number | null; priceImpactBps?: number | null; taxBps?: number | null }): number {
  let bps = 500;
  if (p.ageMinutes != null && p.ageMinutes < 60) bps += 300;
  if (p.ageMinutes != null && p.ageMinutes < 10) bps += 200;
  const vol = Math.abs(p.priceChange5mPct ?? 0);
  if (vol > 50) bps += 500;
  else if (vol > 20) bps += 300;
  if (p.priceImpactBps != null && p.priceImpactBps > 200) bps += Math.min(500, Math.ceil(p.priceImpactBps / 2));
  bps = Math.min(1500, bps);
  return Math.min(5000, bps + Math.max(0, Math.ceil(p.taxBps ?? 0)));
}

/** ETH-side value of a quote: what is spent on a buy, what is expected back on a sell. */
export function ethSideWei(q: Quote): bigint {
  return q.request.side === 'buy' ? q.amountIn : q.grossOut;
}

/** Pure guard evaluation (unit-tested); the async builder feeds it on-chain facts. */
export function evaluateGuards(p: {
  quote: Quote;
  settings: QuickSettings;
  risk?: TokenRiskInfo;
  acknowledgedHighRisk: boolean;
  ethBalanceWei: bigint;
  tokenBalanceWei?: bigint;
  gasCostWei: bigint;
}): { blockers: Guard[]; warnings: string[] } {
  const blockers: Guard[] = [];
  const warnings: string[] = [...p.quote.warnings];
  const side = p.quote.request.side;
  const ethSide = ethSideWei(p.quote);
  if (ethSide > p.settings.maxTradeWei)
    blockers.push({ code: 'OVER_CAP', message: `Above your per-trade cap (${fmtEth(p.settings.maxTradeWei)} ETH). Raise it in trade settings to continue.` });
  if (p.risk?.honeypot) blockers.push({ code: 'HONEYPOT', message: 'Our simulation could not sell this token after buying it (possible honeypot).' });
  if (side === 'buy' && p.risk?.risk === 'high' && !p.acknowledgedHighRisk)
    blockers.push({ code: 'RISK_ACK_REQUIRED', message: `High risk: ${p.risk.verdict ?? 'see the safety panel'}. Confirm "I understand" to buy.` });
  if (side === 'buy' && p.ethBalanceWei < p.quote.amountIn + p.gasCostWei)
    blockers.push({ code: 'INSUFFICIENT_ETH', message: `Not enough ETH: need ${fmtEth(p.quote.amountIn + p.gasCostWei)} incl. gas, have ${fmtEth(p.ethBalanceWei)}.` });
  if (side === 'sell') {
    if ((p.tokenBalanceWei ?? 0n) < p.quote.amountIn) blockers.push({ code: 'INSUFFICIENT_TOKEN', message: 'Not enough tokens for this sell.' });
    if (p.ethBalanceWei < p.gasCostWei) blockers.push({ code: 'INSUFFICIENT_ETH', message: `Not enough ETH for gas (need ~${fmtEth(p.gasCostWei)}).` });
  }
  if (p.quote.priceImpactBps != null && p.quote.priceImpactBps > MAX_IMPACT_BPS)
    blockers.push({ code: 'HIGH_IMPACT', message: `Price impact ${(p.quote.priceImpactBps / 100).toFixed(0)}% is too high; try a smaller amount.` });
  const tax = side === 'buy' ? p.risk?.buyTaxBps : p.risk?.sellTaxBps;
  if (tax != null && tax > 500) warnings.push(`Token tax ~${(tax / 100).toFixed(1)}% on ${side}s`);
  if (p.risk?.risk === 'medium') warnings.push(`Medium risk: ${p.risk.verdict ?? 'check the safety panel'}`);
  return { blockers, warnings };
}

function fmtEth(wei: bigint): string {
  const s = (Number(wei) / 1e18).toFixed(6);
  return s.replace(/\.?0+$/, '');
}

/** One transaction for the embedded wallet (send in order; wait for each receipt). */
export interface WalletCall {
  label: 'approve token for Permit2' | 'allow Universal Router in Permit2' | 'approve token for the curve' | 'swap';
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  /** Gas limit to pass to the wallet (estimated + 30%, or a safe fallback). */
  gas: bigint;
}

export interface QuickTrade {
  ok: boolean;
  blockers: Guard[];
  warnings: string[];
  quote: Quote | null;
  /** Other quoted pools, best first. */
  alternatives: Quote[];
  calls: WalletCall[];
  /** Buys: approvals a later sell will need (send after the buy so sells are one tx). Empty if already set. */
  sellApprovals: WalletCall[];
  slippageBps: number;
  gasCostWei: bigint;
  /** ms since epoch; refresh the quote after `expiresAt`. */
  quotedAt: number;
  expiresAt: number;
  record: TradeRecord | null;
}

export interface QuickTradeRequest {
  side: 'buy' | 'sell';
  token: Address;
  /** Buys: ETH wei to spend (fee included). Sells: token amount. */
  amountIn: bigint;
  trader: Address;
  referral?: Referral | null;
}

export interface QuickTradeOptions {
  settings?: Partial<QuickSettings>;
  risk?: TokenRiskInfo;
  acknowledgedHighRisk?: boolean;
  config?: Partial<TradeConfig>;
  discover?: Omit<DiscoverOptions, 'quoteAsset'> & { pools?: Pool[] };
  /** Simulate the calls from the trader before returning (eth_simulateV1, no state overrides). Default true. */
  simulate?: boolean;
  now?: () => number;
  /** Trade PONS tokens that are still on their bonding curve directly on the curve (default true). */
  curveTrading?: boolean;
  /** SIMULATION/TESTS ONLY: pretend the trader holds these balances (and fund them in the simulation). */
  assume?: { ethWei?: bigint; tokenWei?: bigint };
}

const FALLBACK_GAS = { approve: 80_000n, permit2: 80_000n, swap: 450_000n };
/** Generous fixed swap gas limits per venue (measured: a v4 buy uses ~146k; unused gas is refunded). */
export const SWAP_GAS_FLOOR: Partial<Record<Pool['venue'], bigint>> = { 'uniswap-v2': 250_000n, 'uniswap-v3': 320_000n, 'uniswap-v4': 380_000n };
/** Buys pre-approve when the token allowance is below this (approvals are max/30 days anyway). */
const PREAPPROVE_MIN = 1n << 128n;
const bigMax = (a: bigint, b: bigint) => (a > b ? a : b);

/** ERC-20 → Permit2 (max) and Permit2 → Universal Router (max uint160, 30 days) when missing for `amount`. */
export function quickApprovalCalls(token: Address, a: { erc20ToPermit2: bigint; permit2Amount: bigint; permit2Expiration: number } | null, amount: bigint, nowS: number, cfg: TradeConfig): WalletCall[] {
  if (!a) return [];
  const out: WalletCall[] = [];
  if (a.erc20ToPermit2 < amount)
    out.push({ label: 'approve token for Permit2', chainId: 4663, to: token, value: 0n, gas: FALLBACK_GAS.approve, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TRADE_ADDRESSES.permit2, maxUint256] }) });
  // Renew a day early so a pre-approval made at buy time is still valid when the user sells.
  if (a.permit2Amount < amount || a.permit2Expiration <= nowS + 86_400)
    out.push({
      label: 'allow Universal Router in Permit2',
      chainId: 4663,
      to: TRADE_ADDRESSES.permit2,
      value: 0n,
      gas: FALLBACK_GAS.permit2,
      data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [token, cfg.universalRouter, (1n << 160n) - 1n, nowS + 30 * 86_400] }),
    });
  return out;
}


/**
 * Builds a quick buy/sell for the embedded wallet: a token still on its PONS curve trades directly on
 * the curve (prepareCurveTrade); otherwise the best Universal Router route (ETH quote), automatic or fixed slippage, approval calls for sells (ERC-20 → Permit2,
 * Permit2 → Universal Router, 30-day expiry), guardrails, and a pre-send simulation.
 */
export async function prepareQuickTrade(client: PublicClient, req: QuickTradeRequest, opts: QuickTradeOptions = {}): Promise<QuickTrade> {
  const settings = { ...DEFAULT_QUICK_SETTINGS, ...opts.settings };
  const cfg = resolveConfig(opts.config);
  const now = opts.now?.() ?? Date.now();
  const empty = (blockers: Guard[], warnings: string[] = []): QuickTrade => ({
    ok: false, blockers, warnings, quote: null, alternatives: [], calls: [], sellApprovals: [], slippageBps: 0, gasCostWei: 0n, quotedAt: now, expiresAt: now, record: null,
  });
  if (req.amountIn <= 0n) throw new TradeError('INVALID_AMOUNT', 'amount must be > 0');

  // 1. Pools (ETH-quoted), curve detection.
  const pools = opts.discover?.pools ?? (await discoverPools(client, req.token, { ...opts.discover, quoteAsset: 'ETH', trader: req.trader }));
  // A token still on its PONS curve trades ONLY there; any other pool is not its real market (could be
  // a trap, e.g. a stray 89%-fee v4 pool seen live on a curve token).
  const curve = pools.find((p): p is PonsPool => p.venue === 'pons-curve' && !p.graduated);
  if (curve) {
    if (opts.curveTrading === false) return empty([{ code: 'CURVE_NOT_GRADUATED', message: 'Tradable after graduation: this token is still on its PONS bonding curve.' }]);
    return prepareCurveTrade(client, req, curve, opts, settings, cfg, now, empty);
  }
  const uniswap = pools.filter((p) => p.venue !== 'pons-curve');
  const tradable = uniswap.filter((p) => p.venueFeeBps <= MAX_VENUE_FEE_BPS);
  if (!tradable.length)
    return empty([
      uniswap.length
        ? { code: 'NO_ROUTE', message: `Only pools with fees above ${MAX_VENUE_FEE_BPS / 100}% exist for this token; not routed.` }
        : nonEthQuoteGuard(opts.discover?.apiPools) ?? { code: 'NO_ROUTE', message: 'No Uniswap pool with ETH liquidity for this token yet.' },
    ]);

  // Chain facts the guards need, fetched while the pools quote (one round trip instead of two in a row).
  const facts = Promise.all([
    opts.assume?.ethWei ?? client.getBalance({ address: req.trader }),
    req.side === 'sell' ? (opts.assume?.tokenWei ?? client.readContract({ address: req.token, abi: erc20Abi, functionName: 'balanceOf', args: [req.trader] })) : Promise.resolve(0n),
    client.getGasPrice().catch(() => 100_000_000n),
    opts.assume
      ? Promise.resolve({ erc20ToPermit2: 0n, permit2Amount: 0n, permit2Expiration: 0, permit2Nonce: 0 })
      : req.side === 'sell'
        ? readAllowances(client, req.trader, req.token, cfg.universalRouter)
        : readAllowances(client, req.trader, req.token, cfg.universalRouter).catch(() => null), // buys: only for pre-approval
  ] as const);

  // 2. Quote every pool once, pick the best, then apply the final slippage locally (no re-quote).
  const base = { side: req.side, token: req.token, quoteAsset: 'ETH' as const, amountIn: req.amountIn, trader: req.trader, referral: req.referral ?? null, source: { kind: 'web' as const } };
  const settled = await Promise.allSettled(tradable.map((p) => quotePool(client, p, { ...base, slippageBps: 500 }, cfg)));
  const quotes = rankQuotes(settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : [])));
  if (!quotes.length) {
    void facts.catch(() => undefined);
    const codes = settled.map((x) => (x.status === 'rejected' && isTradeError(x.reason) ? x.reason.code : 'QUOTE_FAILED'));
    if (codes.every((c) => c === 'LIQUIDITY_REMOVED'))
      return empty([{ code: 'LIQUIDITY_REMOVED', message: 'No liquidity left: the pool\'s liquidity was withdrawn by its provider, so this token can\'t be bought or sold.' }]);
    const hookRejected = settled.find((x, i) => {
      const p = tradable[i]!;
      return x.status === 'rejected' && p.venue === 'uniswap-v4' && p.key.hooks !== '0x0000000000000000000000000000000000000000' && isTradeError(x.reason) && x.reason.code === 'QUOTE_FAILED';
    });
    if (hookRejected && hookRejected.status === 'rejected')
      return empty([{ code: 'NO_ROUTE', message: `This token's pool hook rejects ${req.side}s right now (${String(hookRejected.reason.message).replace(/^.*reverted: /, '').slice(0, 60)}).` }]);
    const oneSided = settled.some((x) => x.status === 'rejected' && isTradeError(x.reason) && /no buy-side liquidity/.test(x.reason.message));
    if (oneSided) return empty([{ code: 'NO_ROUTE', message: 'Nothing to sell into yet: this launch pool only has the token side until others buy.' }]);
    if (codes.some((c) => c === 'INSUFFICIENT_LIQUIDITY'))
      return empty([{ code: 'NO_ROUTE', message: 'Not enough liquidity for this amount; try a smaller one.' }]);
    return empty([{ code: 'NO_ROUTE', message: 'Every pool failed to quote.' }]);
  }
  const best0 = quotes[0]!;
  const tax = req.side === 'buy' ? opts.risk?.buyTaxBps : opts.risk?.sellTaxBps;
  const slippageBps = settings.slippageBps ?? autoSlippageBps({ side: req.side, ageMinutes: opts.risk?.ageMinutes, priceChange5mPct: opts.risk?.priceChange5mPct, priceImpactBps: best0.priceImpactBps, taxBps: tax });
  const quote = withSlippage(best0, slippageBps);
  const [ethBal, tokenBal, gasPrice, allowances] = await facts;

  // 3. Calls: approvals (sells) + Universal Router swap. Buys also return the approvals a later sell
  // needs (`sellApprovals`) so the app can send them right after the buy and every sell is one tx.
  const nowS = Math.floor(now / 1000);
  const calls: WalletCall[] = [];
  const built = buildSwap(quote, cfg, { now: nowS });
  const approvals = quickApprovalCalls(req.token, allowances, req.side === 'sell' ? req.amountIn : PREAPPROVE_MIN, nowS, cfg);
  if (req.side === 'sell') calls.push(...approvals);
  calls.push({ label: 'swap', chainId: 4663, to: built.tx.to, data: built.tx.data, value: built.tx.value, gas: SWAP_GAS_FLOOR[quote.pool.venue] ?? FALLBACK_GAS.swap });
  const sellApprovals = req.side === 'buy' && allowances ? approvals : [];

  // 4. Guards.
  // 2x the gas price: the fast sender caps fees at 2x the base fee, and the wallet must cover gas x cap.
  const gasCostWei = calls.reduce((s, c) => s + c.gas, 0n) * gasPrice * 2n;
  const { blockers, warnings } = evaluateGuards({ quote, settings, risk: opts.risk, acknowledgedHighRisk: !!opts.acknowledgedHighRisk, ethBalanceWei: ethBal, tokenBalanceWei: tokenBal, gasCostWei });
  if (quote.pool.venueFeeBps > WARN_VENUE_FEE_BPS) warnings.push(`High pool fee: ${quote.pool.venueFeeLabel}`);

  // 5. Pre-send simulation of exactly these calls from the trader (catches reverts before signing).
  // Gas limit = the larger of simulated use + 30% and a generous per-venue floor, so a quote built a
  // few seconds early still has room and nothing is estimated at click time.
  if (!blockers.length && opts.simulate !== false) {
    const simCalls: SimCall[] = calls.map((c) => ({ from: req.trader, to: c.to, data: c.data, value: c.value, label: c.label }));
    try {
      const sim = await simulateCalls(client, simCalls, opts.assume?.ethWei ? { fund: { [req.trader]: opts.assume.ethWei } } : {});
      const bad = sim.calls.find((c) => !c.ok);
      if (bad) blockers.push({ code: 'SIMULATION_REVERTED', message: `Would fail on-chain (${bad.label}): ${bad.error}` });
      else sim.calls.forEach((c, i) => (calls[i]!.gas = bigMax(calls[i]!.gas, (c.gasUsed * 13n) / 10n + 20_000n)));
    } catch (e) {
      warnings.push(`Pre-send simulation unavailable: ${isTradeError(e) ? e.message : sanitizeRpcMessage(e)}`);
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    quote,
    alternatives: quotes.slice(1),
    calls,
    sellApprovals,
    slippageBps,
    gasCostWei,
    quotedAt: now,
    expiresAt: now + settings.quoteMaxAgeMs,
    record: draftTradeRecord(quote, cfg, built.tx.to, Math.floor(now / 1000)),
  };
}

export const quickBuy = (client: PublicClient, p: { token: Address; ethWei: bigint; trader: Address; referral?: Referral | null }, opts?: QuickTradeOptions) =>
  prepareQuickTrade(client, { side: 'buy', token: p.token, amountIn: p.ethWei, trader: p.trader, referral: p.referral }, opts);

/** Sell an amount, or a percentage of the trader's balance (`percent` 1–100). */
export async function quickSell(client: PublicClient, p: { token: Address; trader: Address; amount?: bigint; percent?: number; referral?: Referral | null }, opts?: QuickTradeOptions) {
  let amount = p.amount;
  if (amount === undefined) {
    const pct = Math.min(100, Math.max(1, Math.round(p.percent ?? 100)));
    const bal = opts?.assume?.tokenWei ?? (await client.readContract({ address: p.token, abi: erc20Abi, functionName: 'balanceOf', args: [p.trader] }));
    amount = (bal * BigInt(pct)) / 100n;
  }
  return prepareQuickTrade(client, { side: 'sell', token: p.token, amountIn: amount, trader: p.trader, referral: p.referral }, opts);
}

/** True while the quote may still be sent; refresh otherwise. */
export function isFresh(t: Pick<QuickTrade, 'expiresAt'>, now = Date.now()): boolean {
  return now <= t.expiresAt;
}

/** Fee summary for the trade box. */
export function feeLine(q: Quote): string {
  if (q.pool.venue === 'pons-curve' && q.fee.feeBps === 0) return 'Rushr fee: free on curve trades during beta';
  const pct = (q.fee.feeBps / 100).toFixed(2).replace(/0$/, '');
  const notes = [
    ...(q.fee.baseFeeBps === BETA_FEE_BPS && BETA_FEE_BPS * 2 === STANDARD_FEE_BPS ? ['beta, half price'] : []),
    ...(q.fee.feeBps < q.fee.baseFeeBps ? ['referral discount'] : []),
  ];
  return `Rushr fee ${pct}%${notes.length ? ` (${notes.join(', ')})` : ''}`;
}



// ---- PONS bonding curve, traded directly ---------------------------------------------------------

/**
 * Rushr's fee on direct curve trades. 0 during the beta: the curve is called straight from the user's
 * wallet (as pons.fun's own UI does), so there is no contract to take a fee in the same transaction.
 * The fee returns once RushrPonsRouter (contracts/) is independently reviewed and deployed.
 */
export const CURVE_FEE_BPS = 0;
export const CURVE_GRADUATED_MESSAGE = 'This token just graduated to Uniswap. Try again to trade it there.';
/** Gas floors for direct curve calls (simulated use + 30% wins when higher). A buy that completes the
 *  curve also migrates the liquidity to Uniswap v4 in the same transaction (measured ~282k; floor 1M). */
export const CURVE_GAS = { buy: 250_000n, sell: 250_000n, graduatingBuy: 1_000_000n, approve: 80_000n };

/** Was the curve completed (liquidity moved to Uniswap)? A trade built against it can no longer fill. */
export async function curveGraduated(client: PublicClient, curve: Address): Promise<boolean> {
  return client.readContract({ address: curve, abi: ponsCurveAbi, functionName: 'graduated' }).catch(() => false);
}

/**
 * Quick buy/sell directly on a PONS bonding curve: `curve.buy(quoteIn, minTokensOut, user)` with
 * `msg.value = quoteIn`, or `curve.sell(tokensIn, minQuoteOut, user)` after `token.approve(curve)`.
 * Quotes come from the curve's own state (virtual reserves, curve fee, creator tax), so the minimums
 * are net of all of them. No Rushr fee (CURVE_FEE_BPS). A buy larger than what is left on the curve
 * is HANDLED by the curve itself: it sells the remaining tokens, graduates in the same transaction and
 * refunds the unused ETH to the buyer; the quote shows that refund.
 */
async function prepareCurveTrade(
  client: PublicClient,
  req: QuickTradeRequest,
  curve: PonsPool,
  opts: QuickTradeOptions,
  settings: QuickSettings,
  cfg: TradeConfig,
  now: number,
  empty: (b: Guard[], w?: string[]) => QuickTrade,
): Promise<QuickTrade> {
  if (curve.nativeQuote === false) return empty([{ code: 'NON_ETH_QUOTE', message: 'This bonding curve is priced in another token, not ETH; not supported yet.' }]);
  if (req.side === 'buy' && curve.snipeTaxBps > 0)
    return empty([{ code: 'SNIPE_TAX_ACTIVE', message: `Launch snipe tax is ${(curve.snipeTaxBps / 100).toFixed(0)}% right now; it drops to 0 within seconds of launch. Try again in a moment.` }]);
  const curveCfg: TradeConfig = { ...cfg, feeBps: CURVE_FEE_BPS };
  const facts = Promise.all([
    opts.assume?.ethWei ?? client.getBalance({ address: req.trader }),
    req.side === 'sell' ? (opts.assume?.tokenWei ?? client.readContract({ address: req.token, abi: erc20Abi, functionName: 'balanceOf', args: [req.trader] })) : Promise.resolve(0n),
    client.getGasPrice().catch(() => 100_000_000n),
    opts.assume ? Promise.resolve(0n) : client.readContract({ address: req.token, abi: erc20Abi, functionName: 'allowance', args: [req.trader, curve.curve] }).catch(() => null),
  ] as const);

  const base = { side: req.side, token: req.token, quoteAsset: 'ETH' as const, amountIn: req.amountIn, trader: req.trader, referral: null, source: { kind: 'web' as const } };
  let quote0: Quote;
  try {
    quote0 = await quotePool(client, curve, { ...base, slippageBps: 500 }, curveCfg); // pure math, no RPC
  } catch (e) {
    void facts.catch(() => undefined);
    return empty([{ code: 'NO_ROUTE', message: isTradeError(e) ? e.message : sanitizeRpcMessage(e) }]);
  }
  const tax = req.side === 'buy' ? opts.risk?.buyTaxBps : opts.risk?.sellTaxBps;
  const slippageBps = settings.slippageBps ?? autoSlippageBps({ side: req.side, ageMinutes: opts.risk?.ageMinutes, priceChange5mPct: opts.risk?.priceChange5mPct, priceImpactBps: quote0.priceImpactBps, taxBps: tax });
  // The router-only warning doesn't apply: this path calls the curve directly.
  const quote = { ...withSlippage(quote0, slippageBps), warnings: quote0.warnings.filter((w) => !/RushrPonsRouter|completes the bonding curve/.test(w)) };
  const [ethBal, tokenBal, gasPrice, allowance] = await facts;

  const graduating = quote.expectedRefund > 0n;
  const approve = (): WalletCall => ({
    label: 'approve token for the curve',
    chainId: 4663,
    to: req.token,
    value: 0n,
    gas: CURVE_GAS.approve,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [curve.curve, maxUint256] }),
  });
  const calls: WalletCall[] = [];
  if (req.side === 'sell' && (allowance ?? 0n) < req.amountIn) calls.push(approve());
  calls.push(
    req.side === 'buy'
      ? { label: 'swap', chainId: 4663, to: curve.curve, value: req.amountIn, gas: graduating ? CURVE_GAS.graduatingBuy : CURVE_GAS.buy, data: encodeFunctionData({ abi: ponsCurveAbi, functionName: 'buy', args: [req.amountIn, quote.minAmountOut, req.trader] }) }
      : { label: 'swap', chainId: 4663, to: curve.curve, value: 0n, gas: CURVE_GAS.sell, data: encodeFunctionData({ abi: ponsCurveAbi, functionName: 'sell', args: [req.amountIn, quote.minAmountOut, req.trader] }) },
  );
  // After a buy, approving the curve now makes the later sell a single transaction.
  const sellApprovals = req.side === 'buy' && allowance !== null && allowance < PREAPPROVE_MIN ? [approve()] : [];

  const gasCostWei = calls.reduce((s, c) => s + c.gas, 0n) * gasPrice * 2n;
  const { blockers, warnings } = evaluateGuards({ quote, settings, risk: opts.risk, acknowledgedHighRisk: !!opts.acknowledgedHighRisk, ethBalanceWei: ethBal, tokenBalanceWei: tokenBal, gasCostWei });
  if (graduating)
    warnings.push(`This buy completes the bonding curve: you get the remaining tokens, the token moves to Uniswap in the same transaction, and about ${fmtEth(quote.expectedRefund)} ETH of unused input is refunded.`);

  if (!blockers.length && opts.simulate !== false) {
    const simCalls: SimCall[] = calls.map((c) => ({ from: req.trader, to: c.to, data: c.data, value: c.value, label: c.label }));
    try {
      const sim = await simulateCalls(client, simCalls, opts.assume?.ethWei ? { fund: { [req.trader]: opts.assume.ethWei } } : {});
      const bad = sim.calls.find((c) => !c.ok);
      // The curve completed since its state was read: this route is gone; the caller re-discovers pools.
      if (bad && /CurveGraduated/.test(bad.error ?? '')) blockers.push({ code: 'CURVE_GRADUATED', message: CURVE_GRADUATED_MESSAGE });
      else if (bad) blockers.push({ code: 'SIMULATION_REVERTED', message: `Would fail on-chain (${bad.label}): ${bad.error}` });
      else sim.calls.forEach((c, i) => (calls[i]!.gas = bigMax(calls[i]!.gas, (c.gasUsed * 13n) / 10n + 20_000n)));
    } catch (e) {
      warnings.push(`Pre-send simulation unavailable: ${isTradeError(e) ? e.message : sanitizeRpcMessage(e)}`);
    }
  }

  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    quote,
    alternatives: [],
    calls,
    sellApprovals,
    slippageBps,
    gasCostWei,
    quotedAt: now,
    expiresAt: now + settings.quoteMaxAgeMs,
    record: draftTradeRecord(quote, curveCfg, curve.curve, Math.floor(now / 1000)),
  };
}

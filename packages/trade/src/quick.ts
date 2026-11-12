import { encodeFunctionData, maxUint256, type Address, type Hex, type PublicClient } from 'viem';
import { TRADE_ADDRESSES } from './addresses';
import { erc20Abi, permit2Abi } from './abis';
import { buildSwap } from './build';
import { resolveConfig, type TradeConfig } from './config';
import { TradeError, isTradeError, sanitizeRpcMessage } from './errors';
import { readAllowances } from './permit2';
import { discoverPools, type DiscoverOptions } from './pools';
import { quotePool, rankQuotes, withSlippage } from './quote';
import { draftTradeRecord, type TradeRecord } from './referral';
import { simulateCalls, type SimCall } from './simulate';
import type { Pool, Quote, Referral } from './types';

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
  | 'NO_ROUTE'
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
  label: 'approve token for Permit2' | 'allow Universal Router in Permit2' | 'swap';
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
 * Builds a quick buy/sell for the embedded wallet: best Universal Router route (ETH quote, PONS curves
 * excluded until graduation), automatic or fixed slippage, approval calls for sells (ERC-20 → Permit2,
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
  // A token still on its PONS curve trades there; any other pool is not its real market (could be a trap).
  if (pools.some((p) => p.venue === 'pons-curve' && !p.graduated))
    return empty([{ code: 'CURVE_NOT_GRADUATED', message: 'Tradable after graduation: this token is still on its PONS bonding curve.' }]);
  const uniswap = pools.filter((p) => p.venue !== 'pons-curve');
  const tradable = uniswap.filter((p) => p.venueFeeBps <= MAX_VENUE_FEE_BPS);
  if (!tradable.length)
    return empty([
      uniswap.length
        ? { code: 'NO_ROUTE', message: `Only pools with fees above ${MAX_VENUE_FEE_BPS / 100}% exist for this token; not routed.` }
        : { code: 'NO_ROUTE', message: 'No Uniswap pool with ETH liquidity for this token yet.' },
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
    return empty([{ code: 'NO_ROUTE', message: 'Every pool failed to quote (no liquidity in range).' }]);
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
  const pct = (q.fee.feeBps / 100).toFixed(2).replace(/0$/, '');
  return `Rushr fee ${pct}%${q.fee.feeBps < q.fee.baseFeeBps ? ' (referral discount)' : ''}`;
}



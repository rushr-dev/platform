import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeFunctionData, erc20Abi, parseEther, type Address, type Hex } from 'viem';
import { ponsCurveAbi } from '@rushr/trade/abis';
import { TRADE_ADDRESSES } from '@rushr/trade/addresses';
import { RUSHR_TREASURY } from '@rushr/trade/config';

/**
 * The checks every trade passes before anything is signed. Ported from Talos
 * (packages/agents/examples/test-agent/talos.ts), Rushr's own test agent, and kept as pure functions
 * so they're tested on their own (test/guards.test.ts).
 */

/** A local refusal. `code` is stable and starts with `refused_`; API refusals keep the API's own code. */
export class GuardError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
    this.details = details;
  }
}

export interface UnsignedTx {
  chainId?: number;
  to: Address;
  data: Hex;
  value: string;
  /** Gas limit suggested by the API (curve builds and fee transfers). */
  gas?: string;
}

/** The Rushr fee on a PONS curve trade: a plain ETH transfer to the treasury, sent after the trade confirms. */
export interface FollowUp {
  kind: 'rushr_fee';
  amount: string;
  tx: UnsignedTx;
  after: 'tx';
  report: string;
}

/** Shape of `POST /v1/trade/build` (llms.txt "Build"). Uniswap builds have `followUp: null`. */
export interface Built {
  tx: UnsignedTx & { chainId: number };
  approvals: { kind: string; token: Address; spender: Address; amount: string; tx: UnsignedTx }[];
  /** Unix seconds; null for curve builds (the curve call has no on-chain deadline). */
  deadline: string | null;
  followUp?: FollowUp | null;
  quote: Quote;
  simulation: { ok: boolean; error?: string; received?: string; feePaid?: string } | null;
  safety?: unknown;
  warnings: string[];
}

export interface Quote {
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  priceImpactBps: number | null;
  slippageBps?: number;
  fee: { feeBps: number; feeAmount: string; feeToken?: string };
  /** `curve` / `id` carry the PONS curve address on `pons-curve` quotes. */
  pool: { venue: string; id?: string; curve?: string };
  warnings?: string[];
}

export const isCurve = (q: Pick<Quote, 'pool'>) => q.pool.venue === 'pons-curve';

/** The one contract a build may send to: the Universal Router Rushr builds for (from @rushr/trade). */
export const ROUTERS: ReadonlySet<string> = new Set([TRADE_ADDRESSES.universalRouter.toLowerCase()]);
export const PERMIT2 = TRADE_ADDRESSES.permit2.toLowerCase();
export const CHAIN_ID = TRADE_ADDRESSES.chainId;
const SELECTOR_ERC20_APPROVE = '0x095ea7b3';
const SELECTOR_PERMIT2_APPROVE = '0x87517c45';
/** Rushr's beta fee. A build asking for more is refused. */
export const MAX_FEE_BPS = 25;

/** Refuses a build that doesn't look like what llms.txt describes. Throws GuardError `refused_unsafe_build`. */
export function vetBuild(b: Built, side: 'buy' | 'sell', token: Address, amountIn: bigint, opts: { requireSimulation?: boolean; trader?: Address; curveOnChain?: Address | null } = {}): void {
  if (isCurve(b.quote)) return vetCurveBuild(b, side, token, amountIn, { trader: opts.trader, curveOnChain: opts.curveOnChain, requireSimulation: opts.requireSimulation });
  const problems: string[] = [];
  if (b.followUp) problems.push('a Uniswap build asked for a follow-up transaction');
  if (b.tx.chainId !== CHAIN_ID) problems.push(`chainId ${b.tx.chainId}`);
  if (!ROUTERS.has(b.tx.to.toLowerCase())) problems.push(`unexpected tx.to ${b.tx.to}`);
  if (side === 'buy' && BigInt(b.tx.value) !== amountIn) problems.push(`tx.value ${b.tx.value} != amountIn ${amountIn}`);
  if (side === 'sell' && BigInt(b.tx.value) !== 0n) problems.push(`sell with value ${b.tx.value}`);
  if (BigInt(b.quote.amountIn) !== amountIn) problems.push('quote.amountIn differs from the request');
  if (b.quote.fee.feeBps > MAX_FEE_BPS) problems.push(`fee ${b.quote.fee.feeBps} bps (max ${MAX_FEE_BPS})`);
  if (side === 'buy' && b.approvals.length) problems.push('ETH buy asked for approvals');
  for (const a of b.approvals) {
    const to = a.tx.to.toLowerCase();
    const sel = a.tx.data.slice(0, 10).toLowerCase();
    const okErc20 = a.kind === 'erc20' && to === token.toLowerCase() && sel === SELECTOR_ERC20_APPROVE;
    const okPermit2 = a.kind === 'permit2' && to === PERMIT2 && sel === SELECTOR_PERMIT2_APPROVE;
    if (!okErc20 && !okPermit2) problems.push(`unexpected approval ${a.kind} to ${a.tx.to} (${sel})`);
    if (BigInt(a.tx.value) !== 0n) problems.push('approval with value');
  }
  if (opts.requireSimulation !== false && !b.simulation?.ok) problems.push(`simulation failed: ${b.simulation?.error ?? 'missing'}`);
  if (problems.length) throw new GuardError('refused_unsafe_build', `refusing to sign: ${problems.join('; ')}`, { problems });
}

export interface ImpactSplit {
  totalBps: number;
  /** Fixed tax the pool's hook takes (PONS-hooked pools: 1-4%), measured with a 1/20-size probe quote. */
  floorBps: number;
  /** Impact caused by the trade's size: total minus the floor. */
  sizeBps: number;
}

/** Size of the probe quote used to measure the floor. */
export const probeAmount = (amountIn: bigint) => amountIn / 20n || 1n;

/**
 * Splits a quote's `priceImpactBps` (which includes any hook tax) into the fixed floor and the part
 * caused by size. A probe can't sensibly show more impact than the full size; if it does, it's all size.
 */
export function splitImpact(totalBps: number | null, probeBps: number | null): ImpactSplit {
  if (totalBps == null) throw new GuardError('refused_price_impact', 'quote has no price impact; refusing to guess');
  const floorBps = Math.max(0, Math.min(probeBps ?? 0, totalBps));
  return { totalBps, floorBps, sizeBps: totalBps - floorBps };
}

/** Throws GuardError `refused_size_impact` or `refused_total_impact`. */
export function checkImpact(i: ImpactSplit, caps: { maxSizeImpactBps: number; maxTotalImpactBps: number }): void {
  const what = `impact ${i.totalBps} bps (${i.floorBps} fixed pool tax + ${i.sizeBps} from size)`;
  if (i.sizeBps > caps.maxSizeImpactBps) throw new GuardError('refused_size_impact', `${what}: size impact over ${caps.maxSizeImpactBps} bps. Try a smaller amount.`, { ...i });
  if (i.totalBps > caps.maxTotalImpactBps) throw new GuardError('refused_total_impact', `${what}: total over ${caps.maxTotalImpactBps} bps`, { ...i });
}

export interface BuyCapInput {
  usd: number;
  amountWei: bigint;
  maxTradeUsd: number;
  dailyUsd: number;
  /** USD already put into buys in the last 24 hours. */
  spent24hUsd: number;
  /** Wallet balance minus the gas reserve. */
  freeWei: bigint;
  dryRun: boolean;
}

/**
 * Per-trade and daily USD caps, and the gas reserve. Returns warnings (dry run only: an unfunded wallet
 * can still be simulated, because the API funds the simulation). Throws GuardError otherwise.
 */
export function checkBuyCaps(i: BuyCapInput): string[] {
  if (!(i.usd > 0) || i.amountWei <= 0n) throw new GuardError('refused_amount', 'amount must be positive');
  if (i.usd > i.maxTradeUsd + 1e-9) throw new GuardError('refused_trade_cap', `$${i.usd.toFixed(2)} is above the per-trade cap of $${i.maxTradeUsd} (RUSHR_MAX_TRADE_USD)`, { usd: i.usd, maxTradeUsd: i.maxTradeUsd });
  const left = Math.max(0, i.dailyUsd - i.spent24hUsd);
  if (i.usd > left + 1e-9) throw new GuardError('refused_daily_cap', `$${i.usd.toFixed(2)} would pass the 24h cap of $${i.dailyUsd} (RUSHR_DAILY_USD): $${i.spent24hUsd.toFixed(2)} spent, $${left.toFixed(2)} left`, { usd: i.usd, dailyUsd: i.dailyUsd, spent24hUsd: i.spent24hUsd });
  if (i.amountWei > i.freeWei) {
    const msg = `needs ${i.amountWei} wei but only ${i.freeWei} wei is spendable after the gas reserve`;
    if (!i.dryRun) throw new GuardError('refused_gas_reserve', msg, { amountWei: i.amountWei.toString(), freeWei: i.freeWei.toString() });
    return [`live, this would be refused: ${msg}`];
  }
  return [];
}

/** Buys in the last 24 hours, kept on disk so the daily cap survives restarts. */
export class SpendLedger {
  private entries: { at: number; usd: number; hash?: string }[] = [];
  constructor(private readonly path: string | null) {
    if (path && existsSync(path)) {
      try {
        this.entries = JSON.parse(readFileSync(path, 'utf8')).entries ?? [];
      } catch {
        this.entries = [];
      }
    }
  }
  spentSince(ms: number, now = Date.now()): number {
    return this.entries.filter((e) => e.at >= now - ms).reduce((s, e) => s + e.usd, 0);
  }
  spent24h(now = Date.now()): number {
    return this.spentSince(86_400_000, now);
  }
  record(usd: number, hash?: string, now = Date.now()): void {
    this.entries = [...this.entries.filter((e) => e.at >= now - 86_400_000), { at: now, usd, hash }];
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(this.path, `${JSON.stringify({ entries: this.entries })}\n`, { mode: 0o600 });
    }
  }
}

/** Blocked tokens (honeypot / spam) are refused before the API is even asked to build. */
export interface Safety {
  riskLevel: 'low' | 'medium' | 'high' | 'unknown';
  verdict: string | null;
  flags: string[];
  blocked: boolean;
  stale?: boolean;
}

export function checkSafety(s: Safety): void {
  if (s.blocked) throw new GuardError('honeypot', `token is blocked by Rushr's safety check (${s.verdict ?? s.flags.join(', ') ?? 'honeypot/spam'})`, { safety: s });
}

// ------------------------------------------------------------------ PONS bonding curves

/** Rushr's fee treasury (a Safe, from @rushr/trade). Curve fees go here and nowhere else. */
export const TREASURY = RUSHR_TREASURY.toLowerCase();
/** An overdue fee (`fee_unpaid`) is paid automatically only up to this much. */
export const MAX_AUTO_FEE_WEI = parseEther('0.005');

const sameAddr = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** A fee transfer: chain 4663, plain ETH (no calldata) to the treasury Safe exactly, of exactly `value`. */
function feeTxProblems(tx: UnsignedTx | null | undefined, value: bigint, label: string): string[] {
  if (!tx) return [`${label}: missing tx`];
  const p: string[] = [];
  if (tx.chainId !== undefined && tx.chainId !== CHAIN_ID) p.push(`${label}: chainId ${tx.chainId}`);
  if (!sameAddr(tx.to, TREASURY)) p.push(`${label}: sends to ${tx.to}, not the treasury ${RUSHR_TREASURY}`);
  if (tx.data && tx.data !== '0x') p.push(`${label}: has calldata`);
  if (BigInt(tx.value) !== value) p.push(`${label}: value ${tx.value} != ${value}`);
  return p;
}

/**
 * A PONS bonding-curve build: the trade goes straight to the token's curve, and Rushr's fee follows as a
 * second, plain transfer. Checks before anything is signed:
 * - `tx.to` is the curve named in the quote's pool, and the curve PONS's factory records for the token
 *   (read on-chain, `curveOnChain`); the calldata is `buy(amountIn, min, this wallet)` or
 *   `sell(amountIn, min, this wallet)` on it;
 * - buys send exactly `amountIn` (the fee is on top), sells send no ETH;
 * - approvals (sells only) are `token.approve(curve)`;
 * - `followUp` is a transfer to the treasury Safe of exactly `quote.fee.feeAmount`, at most 25 bps of the
 *   trade's ETH side;
 * - the simulation succeeded.
 */
export function vetCurveBuild(b: Built, side: 'buy' | 'sell', token: Address, amountIn: bigint, opts: { trader?: Address; curveOnChain?: Address | null; requireSimulation?: boolean } = {}): void {
  const problems: string[] = [];
  const curve = (b.quote.pool.curve ?? b.quote.pool.id ?? '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(curve)) problems.push('quote names no curve address');
  if (b.tx.chainId !== CHAIN_ID) problems.push(`chainId ${b.tx.chainId}`);
  if (!sameAddr(b.tx.to, curve)) problems.push(`tx.to ${b.tx.to} is not the quoted curve ${curve}`);
  if (!opts.curveOnChain) problems.push("couldn't confirm the token's PONS curve on-chain");
  else if (!sameAddr(curve, opts.curveOnChain)) problems.push(`quoted curve ${curve} is not the token's PONS curve ${opts.curveOnChain}`);
  try {
    const call = decodeFunctionData({ abi: ponsCurveAbi, data: b.tx.data });
    if (call.functionName !== side) problems.push(`calldata calls ${call.functionName}, expected ${side}`);
    else {
      const [amt, , recipient] = call.args as readonly [bigint, bigint, Address];
      if (amt !== amountIn) problems.push(`calldata amount ${amt} != ${amountIn}`);
      if (!opts.trader || !sameAddr(recipient, opts.trader)) problems.push(`recipient ${recipient} is not this wallet`);
    }
  } catch {
    problems.push('calldata is not a PONS curve buy or sell');
  }
  if (side === 'buy' && BigInt(b.tx.value) !== amountIn) problems.push(`tx.value ${b.tx.value} != amountIn ${amountIn}`);
  if (side === 'sell' && BigInt(b.tx.value) !== 0n) problems.push(`sell with value ${b.tx.value}`);
  if (BigInt(b.quote.amountIn) !== amountIn) problems.push('quote.amountIn differs from the request');
  if (b.quote.fee.feeBps > MAX_FEE_BPS) problems.push(`fee ${b.quote.fee.feeBps} bps (max ${MAX_FEE_BPS})`);
  if (side === 'buy' && b.approvals.length) problems.push('curve buy asked for approvals');
  for (const a of b.approvals) {
    let ok = a.kind === 'curve' && sameAddr(a.tx.to, token) && BigInt(a.tx.value) === 0n;
    try {
      const d = decodeFunctionData({ abi: erc20Abi, data: a.tx.data });
      ok &&= d.functionName === 'approve' && sameAddr((d.args as readonly [Address, bigint])[0], curve);
    } catch {
      ok = false;
    }
    if (!ok) problems.push(`unexpected approval ${a.kind} to ${a.tx.to}`);
  }
  const f = b.followUp;
  if (!f) problems.push('curve build has no fee follow-up');
  else {
    const fee = BigInt(f.amount);
    if (f.kind !== 'rushr_fee' || f.after !== 'tx') problems.push(`follow-up is ${f.kind}/${f.after}`);
    if (fee !== BigInt(b.quote.fee.feeAmount)) problems.push(`follow-up fee ${fee} != quoted fee ${b.quote.fee.feeAmount}`);
    problems.push(...feeTxProblems(f.tx, fee, 'follow-up'));
    // ETH side: what goes into a buy, or the gross ETH a sell pays out (net + fee).
    const ethSide = side === 'buy' ? amountIn : BigInt(b.quote.amountOut) + fee;
    if (fee * 10_000n > ethSide * BigInt(MAX_FEE_BPS)) problems.push(`follow-up fee ${fee} is above ${MAX_FEE_BPS} bps of ${ethSide}`);
  }
  if (opts.requireSimulation !== false && !b.simulation?.ok) problems.push(`simulation failed: ${b.simulation?.error ?? 'missing'}`);
  if (problems.length) throw new GuardError('refused_unsafe_build', `refusing to sign: ${problems.join('; ')}`, { problems });
}

/** `fee_unpaid` (402): the overdue curve fee and a ready-to-send transfer for it. */
export interface FeeUnpaid {
  owed: string;
  overdue?: string;
  feeTx: UnsignedTx | null;
  trades?: unknown[];
}

/**
 * Whether an overdue fee may be paid without asking: exactly what's owed, to the treasury Safe, at most
 * 0.005 ETH, within what's left of the daily cap and out of the spendable balance. Returns the amount.
 */
export function checkFeeUnpaid(e: FeeUnpaid, i: { feeUsd: number; dailyUsd: number; spent24hUsd: number; freeWei: bigint }): bigint {
  const owed = BigInt(e.owed);
  const problems = feeTxProblems(e.feeTx, owed, 'feeTx');
  if (owed <= 0n) problems.push('nothing owed');
  if (problems.length) throw new GuardError('refused_fee_tx', `won't pay this fee transfer: ${problems.join('; ')}`, { owed: e.owed });
  const pay = 'Pay error.feeTx from this wallet yourself, then report the hash with POST /v1/agents/me/fees.';
  if (owed > MAX_AUTO_FEE_WEI) throw new GuardError('refused_fee_too_large', `this wallet owes ${owed} wei of Rushr curve fees, more than the 0.005 ETH this server pays on its own. ${pay}`, { owed: e.owed });
  if (i.feeUsd > Math.max(0, i.dailyUsd - i.spent24hUsd) + 1e-9) throw new GuardError('refused_daily_cap', `the overdue fee (~$${i.feeUsd.toFixed(2)}) would pass the 24h cap of $${i.dailyUsd} ($${i.spent24hUsd.toFixed(2)} spent). ${pay}`, { owed: e.owed });
  if (owed > i.freeWei) throw new GuardError('refused_gas_reserve', `the overdue fee needs ${owed} wei but only ${i.freeWei} wei is spendable after the gas reserve. ${pay}`, { owed: e.owed });
  return owed;
}

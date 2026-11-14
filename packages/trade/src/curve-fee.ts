import { decodeAbiParameters, type Address, type Hex } from 'viem';
import type { TradeConfig } from './config';
import { BPS, feeOf } from './fees';
import type { CallFrame } from './fee-audit';
import type { QuickTrade, WalletCall } from './quick';

/**
 * Rushr's fee on direct PONS curve trades, paid as a FOLLOW-UP transfer.
 *
 * The curve is called straight from the user's wallet, so nothing in that transaction can pay us. After
 * the trade confirms, the wallet sends a plain ETH transfer to the treasury (the next nonce, through the
 * same sign-only fast path). The fee is computed from the trade's own receipt:
 *
 *   buys:  fee = ETH the curve actually took   × feeBps / 10_000   (on top of the buy amount)
 *   sells: fee = ETH the curve actually paid out × feeBps / 10_000 (out of what was received)
 *
 * Both amounts come from the curve's CurveBuy / CurveSell events. A trade that reverted or never
 * confirmed pays no fee. EIP-7702 batching (one atomic transaction) is the later path: see
 * docs/trading.md "Fees on curve trades".
 */

/** `CurveBuy(address buyer, address recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 creatorTax)` */
export const CURVE_BUY_TOPIC: Hex = '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455';
/** `CurveSell(address seller, address recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 creatorTax)` */
export const CURVE_SELL_TOPIC: Hex = '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df';

/**
 * Gas limit for the fee transfer. A plain transfer uses ~21.5k on chain 4663 (21k plus the L1 data
 * part); the rest is headroom for L1 price spikes and is refunded.
 */
export const CURVE_FEE_GAS = 60_000n;

export interface CurveFill {
  side: 'buy' | 'sell';
  curve: Address;
  /** Buys: ETH the curve took (a buy that completes the curve takes less than it was sent and refunds the rest). Sells: ETH paid out. */
  quoteAmount: bigint;
  tokenAmount: bigint;
}

interface LogLike {
  address: string;
  topics: readonly string[];
  data: string;
}

const lc = (a: string) => a.toLowerCase();
const word = (t: string) => `0x${t.slice(26)}`.toLowerCase();

/** The curve fill for `trader` in a receipt's logs (by the curve's own event), or null if there is none. */
export function curveFillFromLogs(logs: readonly LogLike[], trader: string, curve?: string): CurveFill | null {
  for (const l of logs) {
    const side = l.topics[0] === CURVE_BUY_TOPIC ? 'buy' : l.topics[0] === CURVE_SELL_TOPIC ? 'sell' : null;
    if (!side || l.topics.length < 2 || word(l.topics[1]!) !== lc(trader)) continue;
    if (curve && lc(l.address) !== lc(curve)) continue;
    const [a, b] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], l.data as Hex);
    return side === 'buy'
      ? { side, curve: l.address as Address, quoteAmount: a, tokenAmount: b }
      : { side, curve: l.address as Address, quoteAmount: b, tokenAmount: a };
  }
  return null;
}

/** The fee transfer for an amount (to the treasury, no calldata). */
export function curveFeeCall(cfg: Pick<TradeConfig, 'feeRecipient'>, fee: bigint): WalletCall {
  return { label: 'Rushr fee', chainId: 4663, to: cfg.feeRecipient, value: fee, data: '0x', gas: CURVE_FEE_GAS };
}

/** What a QuickTrade on a curve carries so the app can send the fee once the trade confirms. */
export interface CurveFeeFollowUp {
  kind: 'curve-fee';
  side: 'buy' | 'sell';
  curve: Address;
  trader: Address;
  treasury: Address;
  /** Rate after any referral discount. */
  feeBps: number;
  /** Fee on the quote (shown before the trade; the real one is computed from the receipt). */
  quotedFee: bigint;
}

export interface FollowUpReceipt {
  status: 'success' | 'reverted';
  logs: readonly LogLike[];
}

/**
 * The fee transfer to send after a curve trade, from its receipt. Null when nothing is owed: the trade
 * reverted, the curve reported no fill for the trader, or the fee rounds to 0.
 */
export function followUpFeeCall(f: CurveFeeFollowUp, receipt: FollowUpReceipt): WalletCall | null {
  if (receipt.status !== 'success' || f.feeBps <= 0) return null;
  const fill = curveFillFromLogs(receipt.logs, f.trader, f.curve);
  if (!fill || fill.side !== f.side) return null;
  const fee = feeOf(fill.quoteAmount, f.feeBps);
  return fee > 0n ? curveFeeCall({ feeRecipient: f.treasury }, fee) : null;
}

/** Shorthand for a QuickTrade: the follow-up fee call, or null (not a curve trade, or nothing owed). */
export function tradeFollowUpFee(t: Pick<QuickTrade, 'feeFollowUp'>, receipt: FollowUpReceipt): WalletCall | null {
  return t.feeFollowUp ? followUpFeeCall(t.feeFollowUp, receipt) : null;
}

/**
 * Largest buy that still leaves room for a fee charged ON TOP of it (curve trades):
 * amount + feeOf(amount) <= spendable. `spendable` is the balance minus the gas reserve.
 */
export function maxBuyWei(spendable: bigint, feeOnTopBps: number): bigint {
  if (spendable <= 0n) return 0n;
  if (feeOnTopBps <= 0) return spendable;
  return (spendable * BPS) / (BPS + BigInt(feeOnTopBps));
}

// ---- audit ------------------------------------------------------------------------------------------

export interface FeeTxInfo {
  hash: Hex;
  from: Address;
  to: Address | null;
  value: bigint;
  input: Hex;
  nonce: number;
  status: 'success' | 'reverted';
}

export interface CurveFeeAuditInput {
  hash: Hex;
  from: Address;
  nonce: number;
  value: bigint;
  status: 'success' | 'reverted';
  logs: readonly LogLike[];
  trace?: CallFrame | null;
  feeTx: FeeTxInfo | null;
  treasury: Address;
  feeBps: number;
  referredFeeBps: number;
  referred?: boolean | null;
}

export interface CurveFeeAudit {
  hash: Hex;
  trader: Address;
  side: 'buy' | 'sell' | null;
  curve: Address | null;
  /** ETH the curve took (buys) or paid out (sells): the fee basis. */
  notional: bigint | null;
  expectedFee: bigint | null;
  fee: bigint;
  feeTxHash: Hex | null;
  feeBps: number | null;
  expectedBps: number | null;
  flags: string[];
}

const bpsOf = (fee: bigint, notional: bigint) => (notional > 0n ? Math.round((Number(fee) * 1_000_000) / Number(notional)) / 100 : null);

/**
 * Audit of a curve trade and its follow-up fee transfer: the transfer must come from the trader at
 * the next nonce, go to the treasury with no calldata, succeed, and pay the expected rate on the fill.
 */
export function auditCurveFee(x: CurveFeeAuditInput): CurveFeeAudit {
  const flags: string[] = [];
  const out: CurveFeeAudit = { hash: x.hash, trader: x.from, side: null, curve: null, notional: null, expectedFee: null, fee: 0n, feeTxHash: x.feeTx?.hash ?? null, feeBps: null, expectedBps: null, flags };
  if (x.status !== 'success') {
    flags.push('reverted');
    if (x.feeTx) flags.push('fee_paid_on_failed_trade');
    return out;
  }
  const fill = curveFillFromLogs(x.logs, x.from);
  if (!fill) {
    flags.push('no_curve_fill');
    return out;
  }
  out.side = fill.side;
  out.curve = fill.curve;
  out.notional = fill.quoteAmount;
  const fromRate = x.feeTx && fill.quoteAmount > 0n ? bpsOf(x.feeTx.value, fill.quoteAmount) : null;
  out.expectedBps =
    x.referred === true ? x.referredFeeBps
    : x.referred === false ? x.feeBps
    : fromRate != null && Math.abs(fromRate - x.referredFeeBps) < Math.abs(fromRate - x.feeBps) ? x.referredFeeBps
    : x.feeBps;
  out.expectedFee = feeOf(fill.quoteAmount, out.expectedBps);
  // Some fee in the trade itself (should be none on a direct curve call).
  if (x.trace) {
    const walk = (f: CallFrame): bigint => (f.error ? 0n : (lc(f.to ?? '') === lc(x.treasury) && f.value && f.type !== 'DELEGATECALL' && f.type !== 'STATICCALL' ? BigInt(f.value) : 0n) + (f.calls ?? []).reduce((s, c) => s + walk(c), 0n));
    const inTrade = walk(x.trace);
    if (inTrade > 0n) flags.push('fee_in_trade_tx');
  }
  const t = x.feeTx;
  if (!t) {
    flags.push('fee_missed');
    return out;
  }
  if (t.status !== 'success') flags.push('fee_tx_reverted');
  if (lc(t.from) !== lc(x.from)) flags.push('fee_tx_wrong_sender');
  if (lc(t.to ?? '') !== lc(x.treasury)) flags.push('fee_tx_wrong_recipient');
  if (t.input !== '0x') flags.push('fee_tx_has_calldata');
  if (t.nonce !== x.nonce + 1) flags.push(`fee_tx_nonce_${t.nonce}_expected_${x.nonce + 1}`);
  out.fee = flags.length ? 0n : t.value;
  out.feeBps = bpsOf(out.fee, fill.quoteAmount);
  if (!flags.length) {
    if (out.fee === 0n) flags.push('no_fee');
    else if (out.feeBps != null && Math.abs(out.feeBps - out.expectedBps) > 1) flags.push(`fee_bps_${out.feeBps}_expected_${out.expectedBps}`);
  }
  return out;
}

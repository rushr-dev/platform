import { decodeAbiParameters, decodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { TRADE_ADDRESSES } from './addresses';
import { Command, universalRouterAbi } from './universal-router';

/**
 * Fee audit: did the treasury actually receive the platform fee in a trade built by Rushr?
 *
 * Read-only and pure: give it a transaction, its receipt logs and (for ETH fees) its call trace, and it
 * reports the fee the treasury received against the rate the fee commands encoded and the rate the config
 * expects. Flags use the same names as the indexer's trade ledger (`no_fee`, `fee_bps_<x>_expected_<y>`)
 * plus a few audit-only ones. Run it with `scripts/fee-audit.ts`.
 */

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface CallFrame {
  type?: string;
  from?: string;
  to?: string;
  value?: string;
  error?: string;
  calls?: CallFrame[];
}

export interface AuditLog {
  address: string;
  topics: string[];
  data: string;
}

/** A fee command in a Universal Router call that pays the treasury. */
export interface FeeCommand {
  command: 'TRANSFER' | 'PERMIT2_TRANSFER_FROM' | 'PAY_PORTION';
  asset: Address;
  /** Amount for TRANSFER / PERMIT2_TRANSFER_FROM; bips for PAY_PORTION. */
  value: bigint;
}

export interface FeeAuditInput {
  hash: Hex;
  from: Address;
  to: Address | null;
  value: bigint;
  input: Hex;
  status: 'success' | 'reverted';
  logs: AuditLog[];
  /** callTracer frame; null when the RPC has no debug_traceTransaction (ETH flows are then unknown). */
  trace: CallFrame | null;
  treasury: Address;
  universalRouter?: Address;
  /** Expected rates: the base rate and the referred rate (`effectiveFeeBps`). */
  feeBps: number;
  referredFeeBps: number;
  /** True / false when known (the ledger's `referrer`); null or undefined to infer from the calldata. */
  referred?: boolean | null;
}

export interface FeeAudit {
  hash: Hex;
  trader: Address;
  side: 'buy' | 'sell' | null;
  quoteAsset: 'ETH' | 'USDG' | null;
  /** Quote-side size of the trade: the input on buys, the gross output (net + fee) on sells. */
  notional: bigint | null;
  /** What the treasury received, per asset ('ETH' or a token address). */
  received: Record<string, bigint>;
  /** The fee in the expected asset. */
  fee: bigint;
  feeBps: number | null;
  expectedBps: number | null;
  /** Rate the fee commands themselves encode (PAY_PORTION bips, or TRANSFER amount / input). */
  calldataBps: number | null;
  commands: FeeCommand[];
  flags: string[];
}

const lc = (a: string | null | undefined) => (a ?? '').toLowerCase();

/** Native ETH moved to `to` by successful calls anywhere in the trace (same rule as the indexer ledger). */
export function ethReceivedIn(frame: CallFrame, to: string): bigint {
  let sum = 0n;
  const t = lc(to);
  const walk = (f: CallFrame) => {
    if (f.error) return;
    if (lc(f.to) === t && f.value && f.type !== 'DELEGATECALL' && f.type !== 'STATICCALL') sum += BigInt(f.value);
    for (const ch of f.calls ?? []) walk(ch);
  };
  walk(frame);
  return sum;
}

/** Net ERC-20 flow of `token` into `who` (negative when out), from Transfer logs. */
export function tokenFlowIn(logs: AuditLog[], token: string, who: string): bigint {
  let net = 0n;
  const w = lc(who);
  for (const l of logs) {
    if (lc(l.address) !== lc(token) || l.topics[0] !== TRANSFER_TOPIC || l.topics.length !== 3) continue;
    const from = `0x${l.topics[1]!.slice(26)}`;
    const to = `0x${l.topics[2]!.slice(26)}`;
    const v = BigInt(l.data);
    if (to === w) net += v;
    if (from === w) net -= v;
  }
  return net;
}

/** Fee commands paying `treasury` in a Universal Router `execute` call; null if the input isn't one. */
export function feeCommands(input: Hex, treasury: Address): FeeCommand[] | null {
  let args: readonly unknown[];
  try {
    args = decodeFunctionData({ abi: universalRouterAbi, data: input }).args;
  } catch {
    return null;
  }
  const commands = args[0] as Hex;
  const inputs = args[1] as readonly Hex[];
  const out: FeeCommand[] = [];
  const ids = commands.slice(2).match(/../g) ?? [];
  ids.forEach((byte, i) => {
    const id = parseInt(byte, 16) & 0x3f;
    const name = id === Command.TRANSFER ? 'TRANSFER' : id === Command.PAY_PORTION ? 'PAY_PORTION' : id === Command.PERMIT2_TRANSFER_FROM ? 'PERMIT2_TRANSFER_FROM' : null;
    if (!name || !inputs[i]) return;
    const [asset, recipient, value] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], inputs[i]!);
    if (lc(recipient) === lc(treasury)) out.push({ command: name, asset: getAddress(asset), value });
  });
  return out;
}

const bpsOf = (fee: bigint, notional: bigint) => (notional > 0n ? Math.round((Number(fee) * 1_000_000) / Number(notional)) / 100 : null);

export function auditFee(x: FeeAuditInput): FeeAudit {
  const flags: string[] = [];
  const ur = x.universalRouter ?? TRADE_ADDRESSES.universalRouter;
  const usdg = TRADE_ADDRESSES.usdg;
  const base: FeeAudit = { hash: x.hash, trader: x.from, side: null, quoteAsset: null, notional: null, received: {}, fee: 0n, feeBps: null, expectedBps: null, calldataBps: null, commands: [], flags };
  if (x.status !== 'success') {
    flags.push('reverted');
    return base;
  }
  if (lc(x.to) !== lc(ur)) flags.push('not_universal_router');
  const cmds = feeCommands(x.input, x.treasury) ?? [];
  base.commands = cmds;
  if (!cmds.length) flags.push('no_fee_command');

  // Side and quote asset: from the fee command when there is one, otherwise from the flows.
  const cmd = cmds[0];
  const usdgNet = tokenFlowIn(x.logs, usdg, x.from);
  const side: 'buy' | 'sell' = cmd ? (cmd.command === 'PAY_PORTION' ? 'sell' : 'buy') : x.value > 0n || usdgNet < 0n ? 'buy' : 'sell';
  const quoteAsset: 'ETH' | 'USDG' = cmd ? (lc(cmd.asset) === lc(usdg) ? 'USDG' : 'ETH') : x.value > 0n ? 'ETH' : usdgNet !== 0n ? 'USDG' : 'ETH';
  base.side = side;
  base.quoteAsset = quoteAsset;

  // What the treasury received: ETH from the trace, tokens from Transfer logs.
  if (x.trace) {
    const eth = ethReceivedIn(x.trace, x.treasury);
    if (eth > 0n) base.received.ETH = eth;
  } else if (quoteAsset === 'ETH') flags.push('no_trace');
  for (const token of new Set(x.logs.filter((l) => l.topics[0] === TRANSFER_TOPIC).map((l) => lc(l.address)))) {
    const v = tokenFlowIn(x.logs, token, x.treasury);
    if (v > 0n) base.received[getAddress(token)] = v;
  }
  const expectedKey = quoteAsset === 'ETH' ? 'ETH' : getAddress(usdg);
  base.fee = base.received[expectedKey] ?? 0n;
  for (const k of Object.keys(base.received)) if (k !== expectedKey) flags.push(`fee_wrong_asset_${k === getAddress(TRADE_ADDRESSES.weth) ? 'WETH' : k}`);

  // Notional on the quote side (same definition as the ledger: buys = input, sells = net out + fee).
  if (quoteAsset === 'ETH') {
    if (side === 'buy') base.notional = x.value - (x.trace ? ethReceivedIn(x.trace, x.from) : 0n);
    else if (x.trace) base.notional = ethReceivedIn(x.trace, x.from) + base.fee;
  } else {
    base.notional = side === 'buy' ? -usdgNet : usdgNet + base.fee;
  }

  if (cmd) base.calldataBps = cmd.command === 'PAY_PORTION' ? Number(cmd.value) : base.notional ? bpsOf(cmd.value, base.notional) : null;
  base.expectedBps =
    x.referred === true ? x.referredFeeBps
    : x.referred === false ? x.feeBps
    : base.calldataBps != null && Math.abs(base.calldataBps - x.referredFeeBps) < Math.abs(base.calldataBps - x.feeBps) ? x.referredFeeBps
    : x.feeBps;
  if (base.calldataBps != null && Math.abs(base.calldataBps - base.expectedBps) > 1) flags.push(`calldata_bps_${base.calldataBps}_expected_${base.expectedBps}`);

  if (quoteAsset === 'ETH' && !x.trace) return base; // ETH fees are only visible in a trace
  if (base.notional != null) base.feeBps = bpsOf(base.fee, base.notional);
  if (base.fee === 0n) flags.push('no_fee');
  else if (base.feeBps != null && Math.abs(base.feeBps - base.expectedBps) > 1) flags.push(`fee_bps_${base.feeBps}_expected_${base.expectedBps}`);
  return base;
}


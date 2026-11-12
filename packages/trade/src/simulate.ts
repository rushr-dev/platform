import { encodeFunctionData, maxUint256, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { TRADE_ADDRESSES } from './addresses';
import { erc20Abi, permit2Abi } from './abis';
import { decodeRevert } from './revert';
export { decodeRevert };
import type { TradeConfig } from './config';
import { TradeError, sanitizeRpcMessage } from './errors';
import { BPS } from './fees';
import { buildSwap } from './build';
import type { BuiltSwap, Pool, Quote } from './types';

/**
 * Simulation only: everything here runs through eth_simulateV1 / eth_call against current state with
 * `validation: false`, so no signature, key or funds are involved and nothing is broadcast.
 */

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** eth_simulateV1 traceTransfers reports native ETH moves as Transfer logs from this address. */
export const NATIVE_TRANSFER_EMITTER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT48 = 2 ** 48 - 1;

export interface SimCall {
  from: Address;
  to: Address;
  data: Hex;
  value?: bigint;
  /** Shown in results. */
  label: string;
}

export interface TransferEvent {
  /** Token address, or NATIVE_TRANSFER_EMITTER for ETH. */
  token: Address;
  from: Address;
  to: Address;
  value: bigint;
  callIndex: number;
}

export interface SimCallResult {
  label: string;
  ok: boolean;
  gasUsed: bigint;
  returnData: Hex;
  error?: string;
}

export interface SimulationResult {
  ok: boolean;
  calls: SimCallResult[];
  transfers: TransferEvent[];
}

interface RawSimCall {
  status: Hex;
  gasUsed: Hex;
  returnData: Hex;
  error?: { message?: string; data?: Hex };
  logs?: { address: Address; topics: Hex[]; data: Hex }[];
}

function lc(a: string): Address {
  return a.toLowerCase() as Address;
}

/** Runs calls in one simulated block. `fund` gives addresses an ETH balance via state override. */
export async function simulateCalls(client: PublicClient, calls: SimCall[], opts: { fund?: Record<Address, bigint>; blockTag?: 'latest' | 'pending' } = {}): Promise<SimulationResult> {
  const stateOverrides: Record<string, { balance: Hex }> = {};
  for (const [a, wei] of Object.entries(opts.fund ?? {})) stateOverrides[a] = { balance: toHex(wei) };
  let raw: { calls: RawSimCall[] }[];
  try {
    raw = (await client.request({
      method: 'eth_simulateV1' as never,
      params: [
        {
          blockStateCalls: [
            {
              stateOverrides,
              calls: calls.map((c) => ({ from: c.from, to: c.to, data: c.data, value: toHex(c.value ?? 0n) })),
            },
          ],
          validation: false,
          traceTransfers: true,
        },
        opts.blockTag ?? 'latest',
      ] as never,
    })) as never;
  } catch (e) {
    const msg = sanitizeRpcMessage(e);
    if (/method.*not (found|supported)|does not exist/i.test(msg)) throw new TradeError('SIMULATION_UNSUPPORTED', 'RPC does not support eth_simulateV1');
    throw new TradeError('RPC_ERROR', `simulation request failed: ${msg}`);
  }
  const block = raw[0];
  if (!block) throw new TradeError('RPC_ERROR', 'empty simulation result');
  const transfers: TransferEvent[] = [];
  const results: SimCallResult[] = block.calls.map((c, i) => {
    for (const l of c.logs ?? [])
      if (l.topics[0] === TRANSFER_TOPIC && l.topics.length === 3)
        transfers.push({ token: lc(l.address), from: lc(`0x${l.topics[1]!.slice(26)}`), to: lc(`0x${l.topics[2]!.slice(26)}`), value: BigInt(l.data), callIndex: i });
    const ok = c.status === '0x1';
    return { label: calls[i]!.label, ok, gasUsed: BigInt(c.gasUsed), returnData: c.returnData, error: ok ? undefined : decodeRevert(c.error?.data ?? c.returnData) };
  });
  return { ok: results.every((r) => r.ok), calls: results, transfers };
}

/** Approval calls as plain transactions from the trader (no signatures), for simulation. */
export function approvalCalls(built: BuiltSwap, trader: Address): SimCall[] {
  return built.approvals.map((a) =>
    a.kind === 'erc20'
      ? { from: trader, to: a.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [a.spender, maxUint256] }), label: `approve ${a.token.slice(0, 8)}… → ${a.spender.slice(0, 8)}…` }
      : {
          from: trader,
          to: TRADE_ADDRESSES.permit2,
          data: encodeFunctionData({ abi: permit2Abi, functionName: 'approve', args: [a.token, a.spender, a.amount > MAX_UINT160 ? MAX_UINT160 : a.amount, MAX_UINT48] }),
          label: `Permit2.approve ${a.token.slice(0, 8)}… → ${a.spender.slice(0, 8)}…`,
        },
  );
}

export function swapCall(built: BuiltSwap, label = 'swap'): SimCall {
  return { from: built.quote.request.trader, to: built.tx.to, data: built.tx.data, value: built.tx.value, label };
}

/** Addresses that pay out / take in the token on this pool's venue. */
export function venueAddresses(pool: Pool): Address[] {
  switch (pool.venue) {
    case 'uniswap-v4':
      return [TRADE_ADDRESSES.v4.poolManager];
    case 'pons-curve':
      return [pool.curve];
    default:
      return [lc(pool.id)];
  }
}

function sum(ts: TransferEvent[], f: (t: TransferEvent) => boolean): bigint {
  return ts.filter(f).reduce((a, t) => a + t.value, 0n);
}

export interface SwapSimulation {
  ok: boolean;
  error?: string;
  calls: SimCallResult[];
  gasUsed: bigint;
  /** What the trader received of the output asset (token on buys, ETH/USDG on sells). */
  received: bigint;
  /** What the treasury received in the fee asset. */
  feePaid: bigint;
  /** Measured transfer tax on the token leg, in bps (null when not measurable). */
  tokenTaxBps: number | null;
  meetsMinimum: boolean;
}

/** Simulates approvals + the swap from the trader. `fundEth` tops up the trader's balance in the simulation only. */
export async function simulateSwap(client: PublicClient, built: BuiltSwap, cfg: TradeConfig, opts: { fundEth?: bigint; withApprovals?: boolean } = {}): Promise<SwapSimulation> {
  const trader = lc(built.quote.request.trader);
  const calls = [...(opts.withApprovals === false ? [] : approvalCalls(built, trader)), swapCall(built)];
  const sim = await simulateCalls(client, calls, opts.fundEth ? { fund: { [trader]: opts.fundEth } } : {});
  const swapIndex = calls.length - 1;
  const ts = sim.transfers.filter((t) => t.callIndex === swapIndex);
  const analysis = analyzeSwapTransfers(built.quote, ts, cfg.feeRecipient);
  const swap = sim.calls[swapIndex]!;
  return {
    ok: sim.ok,
    error: sim.calls.find((c) => !c.ok)?.error,
    calls: sim.calls,
    gasUsed: swap.gasUsed,
    ...analysis,
    meetsMinimum: sim.ok && analysis.received >= built.quote.minAmountOut,
  };
}

/** Pure analysis of a swap's transfers (unit-tested). */
export function analyzeSwapTransfers(q: Quote, ts: TransferEvent[], feeRecipient: Address): { received: bigint; feePaid: bigint; tokenTaxBps: number | null } {
  const trader = lc(q.request.trader);
  const treasury = lc(feeRecipient);
  const token = lc(q.pool.token);
  const venue = new Set(venueAddresses(q.pool).map(lc));
  const feeAsset = q.fee.feeToken === TRADE_ADDRESSES.eth ? NATIVE_TRANSFER_EMITTER : lc(q.fee.feeToken);
  const feePaid = sum(ts, (t) => t.token === feeAsset && t.to === treasury);
  if (q.request.side === 'buy') {
    const received = sum(ts, (t) => t.token === token && t.to === trader);
    const venueOut = sum(ts, (t) => t.token === token && venue.has(t.from));
    const tokenTaxBps = venueOut > 0n && received <= venueOut ? Number(((venueOut - received) * BPS) / venueOut) : null;
    return { received, feePaid, tokenTaxBps };
  }
  const outAsset = q.pool.quote === TRADE_ADDRESSES.usdg ? lc(TRADE_ADDRESSES.usdg) : NATIVE_TRANSFER_EMITTER;
  const received = sum(ts, (t) => t.token === outAsset && t.to === trader);
  const sent = sum(ts, (t) => t.token === token && t.from === trader);
  const venueIn = sum(ts, (t) => t.token === token && venue.has(t.to));
  const tokenTaxBps = sent > 0n && venueIn <= sent ? Number(((sent - venueIn) * BPS) / sent) : null;
  return { received, feePaid, tokenTaxBps };
}

export interface TokenSafety {
  buyOk: boolean;
  sellOk: boolean;
  buyTaxBps: number | null;
  sellTaxBps: number | null;
  /** Round trip: quote-asset value back after buy + sell, in bps of what was spent (fees and impact included). */
  roundTripBps: number | null;
  honeypot: boolean;
  error?: string;
}

/**
 * Buy then sell the received amount in one simulated block (minimums 0: a probe, never signed), and
 * measure buy/sell tax from the token's own Transfer logs. Funds the trader in the simulation only.
 */
export async function probeTokenSafety(client: PublicClient, buyQuote: Quote, cfg: TradeConfig): Promise<TokenSafety> {
  if (buyQuote.request.side !== 'buy') throw new TradeError('INVALID_AMOUNT', 'probeTokenSafety takes a buy quote');
  const trader = lc(buyQuote.request.trader);
  const probeBuy: Quote = { ...buyQuote, minAmountOut: 0n, minGrossOut: 0n };
  const buyBuilt = buildSwap(probeBuy, cfg);
  // Sell slightly less than quoted so a small tax does not make the probe itself revert.
  const sellAmount = (buyQuote.amountOut * 9_000n) / BPS;
  const probeSell: Quote = {
    ...buyQuote,
    request: { ...buyQuote.request, side: 'sell', amountIn: sellAmount },
    amountIn: sellAmount,
    swapAmountIn: sellAmount,
    grossOut: 0n,
    amountOut: 0n,
    minAmountOut: 0n,
    minGrossOut: 0n,
    fee: { ...buyQuote.fee, side: 'sell', feeAmount: 0n },
  };
  const sellBuilt = buildSwap(probeSell, cfg);
  const calls = [swapCall(buyBuilt, 'probe buy'), ...approvalCalls(sellBuilt, trader), swapCall(sellBuilt, 'probe sell')];
  const sim = await simulateCalls(client, calls, { fund: { [trader]: buyQuote.amountIn + 10n ** 17n } });
  const buyIdx = 0;
  const sellIdx = calls.length - 1;
  const buyRes = sim.calls[buyIdx]!;
  const sellRes = sim.calls[sellIdx]!;
  const buyA = analyzeSwapTransfers(probeBuy, sim.transfers.filter((t) => t.callIndex === buyIdx), cfg.feeRecipient);
  const sellA = analyzeSwapTransfers(probeSell, sim.transfers.filter((t) => t.callIndex === sellIdx), cfg.feeRecipient);
  const spentForSold = buyA.received > 0n ? (buyQuote.amountIn * sellAmount) / buyA.received : 0n;
  return {
    buyOk: buyRes.ok,
    sellOk: sellRes.ok,
    buyTaxBps: buyA.tokenTaxBps,
    sellTaxBps: sellRes.ok ? sellA.tokenTaxBps : null,
    roundTripBps: sellRes.ok && spentForSold > 0n ? Number((sellA.received * BPS) / spentForSold) : null,
    honeypot: buyRes.ok && !sellRes.ok,
    error: sim.calls.find((c) => !c.ok)?.error,
  };
}

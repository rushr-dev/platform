import { pad, toHex, type Address, type PublicClient } from 'viem';
import { resolveConfig, type TradeConfig } from './config';
import { auditFee, type AuditLog, type CallFrame, type FeeAudit } from './fee-audit';
import { quickBuy, quickSell, type QuickTradeOptions } from './quick';
import { NATIVE_TRANSFER_EMITTER, simulateCalls, type TransferEvent } from './simulate';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface FeeRoundTrip {
  token: Address;
  venue: string;
  buy: { ethIn: bigint; treasuryDelta: bigint; expectedFee: bigint; audit: FeeAudit };
  sell: { tokensIn: bigint; treasuryDelta: bigint; quotedFee: bigint; audit: FeeAudit };
}

/** The audit's inputs rebuilt from one simulated call's transfers (ETH ones come from traceTransfers). */
function auditInput(ts: TransferEvent[]): { trace: CallFrame; logs: AuditLog[] } {
  const eth = ts.filter((t) => t.token === NATIVE_TRANSFER_EMITTER);
  const tok = ts.filter((t) => t.token !== NATIVE_TRANSFER_EMITTER);
  return {
    trace: { type: 'CALL', calls: eth.map((t) => ({ type: 'CALL', from: t.from, to: t.to, value: toHex(t.value) })) },
    logs: tok.map((t) => ({ address: t.token, topics: [TRANSFER_TOPIC, pad(t.from), pad(t.to)], data: toHex(t.value, { size: 32 }) })),
  };
}

/**
 * Read-only: a Universal Router quick buy, then a sell of the minimum tokens received, in ONE
 * eth_simulateV1 block from `trader` with a simulated balance. Reports the ETH the treasury received in
 * each (from the simulated transfers) and runs the fee audit on each swap. Nothing is signed or sent.
 */
export async function feeRoundTrip(client: PublicClient, token: Address, ethIn: bigint, trader: Address, opts: Pick<QuickTradeOptions, 'discover' | 'config'> = {}): Promise<FeeRoundTrip> {
  const cfg: TradeConfig = resolveConfig(opts.config);
  const fund = 10n ** 18n + ethIn;
  const base = { ...opts, simulate: false, acknowledgedHighRisk: true, settings: { maxTradeWei: fund }, curveTrading: false } as const;
  const buy = await quickBuy(client, { token, ethWei: ethIn, trader }, { ...base, assume: { ethWei: fund } });
  if (!buy.quote || buy.quote.pool.venue === 'pons-curve') throw new Error(`${token}: no Universal Router route: ${buy.blockers.map((b) => b.message).join('; ')}`);
  const tokensIn = buy.quote.minAmountOut;
  const sell = await quickSell(client, { token, trader, amount: tokensIn }, { ...base, assume: { ethWei: fund, tokenWei: tokensIn } });
  if (!sell.quote) throw new Error(`${token}: sell blocked: ${sell.blockers.map((b) => b.message).join('; ')}`);
  const calls = [...buy.calls.filter((c) => c.label === 'swap'), ...sell.calls];
  const sim = await simulateCalls(client, calls.map((c) => ({ from: trader, to: c.to, data: c.data, value: c.value, label: c.label })), { fund: { [trader]: fund } });
  const bad = sim.calls.find((c) => !c.ok);
  if (bad) throw new Error(`${token}: ${bad.label} reverted: ${bad.error}`);
  const t = cfg.feeRecipient.toLowerCase();
  const sellIdx = calls.length - 1;
  const delta = (i: number) => sim.transfers.filter((x) => x.callIndex === i && x.token === NATIVE_TRANSFER_EMITTER && x.to === t).reduce((s, x) => s + x.value, 0n);
  const audit = (i: number) => {
    const c = calls[i]!;
    return auditFee({ hash: `0x${String(i).padStart(64, '0')}`, from: trader, to: c.to, value: c.value, input: c.data, status: 'success', ...auditInput(sim.transfers.filter((x) => x.callIndex === i)), treasury: cfg.feeRecipient, feeBps: cfg.feeBps, referredFeeBps: buy.quote!.fee.feeBps, referred: buy.quote!.fee.feeBps < buy.quote!.fee.baseFeeBps });
  };
  return {
    token,
    venue: buy.quote.pool.venue,
    buy: { ethIn, treasuryDelta: delta(0), expectedFee: buy.quote.fee.feeAmount, audit: audit(0) },
    sell: { tokensIn, treasuryDelta: delta(sellIdx), quotedFee: sell.quote.fee.feeAmount, audit: audit(sellIdx) },
  };
}

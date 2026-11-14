import type { Address, PublicClient } from 'viem';
import { resolveConfig } from './config';
import { auditCurveFee, curveFillFromLogs, followUpFeeCall, type CurveFeeAudit } from './curve-fee';
import { ponsBuyCapped } from './math';
import { discoverPools } from './pools';
import { quickBuy, quickSell, type WalletCall } from './quick';
import { NATIVE_TRANSFER_EMITTER, simulateCalls } from './simulate';
import type { PonsPool, Referral } from './types';

export interface CurveFeeLeg {
  /** ETH the curve took (buy) or paid out (sell), from its own event in the simulated receipt. */
  notional: bigint;
  /** The fee transfer the app would send, built from that receipt. */
  fee: bigint;
  /** ETH the treasury actually received in the simulation (from traceTransfers). */
  treasuryDelta: bigint;
  /** ETH that actually moved between the trader and the curve (cross-check of the event). */
  ethMoved: bigint;
  audit: CurveFeeAudit;
}

export interface CurveFeeRoundTrip {
  token: Address;
  curve: Address;
  feeBps: number;
  buy: CurveFeeLeg & { ethIn: bigint };
  sell: CurveFeeLeg & { tokensIn: bigint; quotedNetOut: bigint };
  calls: string[];
}

/**
 * Read-only check of the follow-up fee on a live PONS curve. Two eth_simulateV1 runs from `trader` with a
 * simulated balance; nothing is signed or broadcast:
 *   1. [curve buy, approve, curve sell] as the app builds them; the fee transfers are then built from
 *      those receipts with `followUpFeeCall`, exactly as the app does after a confirmed trade.
 *   2. [curve buy, fee transfer, approve, curve sell, fee transfer]: the treasury's ETH delta per transfer.
 * The sell sells the tokens the buy returned, quoted from the curve state after the buy.
 */
export async function curveFeeRoundTrip(client: PublicClient, token: Address, ethIn: bigint, trader: Address, opts: { referral?: Referral | null } = {}): Promise<CurveFeeRoundTrip> {
  const cfg = resolveConfig();
  const pools = await discoverPools(client, token, { quoteAsset: 'ETH', venues: ['pons-curve'], trader });
  const curve = pools.find((p): p is PonsPool => p.venue === 'pons-curve' && !p.graduated);
  if (!curve) throw new Error(`${token}: no live curve`);
  const fund = 10n ** 18n + ethIn;
  const base = { simulate: false, acknowledgedHighRisk: true, settings: { maxTradeWei: fund } } as const;
  const buy = await quickBuy(client, { token, ethWei: ethIn, trader, referral: opts.referral }, { ...base, discover: { pools: [curve] }, assume: { ethWei: fund } });
  if (!buy.ok || !buy.quote || !buy.feeFollowUp) throw new Error(`${token}: buy blocked: ${buy.blockers.map((b) => b.message).join('; ')}`);
  const tokens = buy.quote.amountOut;
  const used = ponsBuyCapped(ethIn, curve).used;
  const net = used - (used * BigInt(curve.feeBps)) / 10_000n - (used * BigInt(curve.creatorTaxBps)) / 10_000n;
  const after: PonsPool = { ...curve, quoteReserve: curve.quoteReserve + net, tokenReserve: curve.tokenReserve - tokens, realQuoteReserve: curve.realQuoteReserve + net };
  const sell = await quickSell(client, { token, trader, amount: tokens, referral: opts.referral }, { ...base, discover: { pools: [after] }, assume: { ethWei: fund, tokenWei: tokens } });
  if (!sell.quote || !sell.feeFollowUp) throw new Error(`${token}: sell blocked: ${sell.blockers.map((b) => b.message).join('; ')}`);

  const sim = (calls: WalletCall[]) => simulateCalls(client, calls.map((c) => ({ from: trader, to: c.to, data: c.data, value: c.value, label: c.label })), { fund: { [trader]: fund } });
  const trades = [buy.calls[0]!, ...sell.calls];
  const first = await sim(trades);
  const bad = first.calls.find((c) => !c.ok);
  if (bad) throw new Error(`${token}: ${bad.label} reverted: ${bad.error}`);
  const buyFee = followUpFeeCall(buy.feeFollowUp, { status: 'success', logs: first.calls[0]!.logs });
  const sellFee = followUpFeeCall(sell.feeFollowUp, { status: 'success', logs: first.calls.at(-1)!.logs });
  if (!buyFee || !sellFee) throw new Error(`${token}: no fee owed (no curve fill in the receipt?)`);

  const all = [buy.calls[0]!, buyFee, ...sell.calls, sellFee];
  const second = await sim(all);
  const bad2 = second.calls.find((c) => !c.ok);
  if (bad2) throw new Error(`${token}: ${bad2.label} reverted: ${bad2.error}`);
  const t = cfg.feeRecipient.toLowerCase();
  const c = curve.curve.toLowerCase();
  const eth = (i: number, from: string, to: string) => second.transfers.filter((x) => x.callIndex === i && x.token === NATIVE_TRANSFER_EMITTER && x.from === from && x.to === to).reduce((s, x) => s + x.value, 0n);
  const tr = trader.toLowerCase();
  const sellIdx = all.length - 2;
  const leg = (tradeIdx: number, feeIdx: number, fee: WalletCall, side: 'buy' | 'sell'): CurveFeeLeg => {
    const fill = curveFillFromLogs(second.calls[tradeIdx]!.logs, trader)!;
    const ethMoved = side === 'buy' ? eth(tradeIdx, tr, c) - eth(tradeIdx, c, tr) : eth(tradeIdx, c, tr);
    const audit = auditCurveFee({
      hash: `0x${String(tradeIdx).padStart(64, '0')}`, from: trader, nonce: tradeIdx, value: all[tradeIdx]!.value, status: 'success', logs: second.calls[tradeIdx]!.logs,
      feeTx: { hash: `0x${String(feeIdx).padStart(64, '0')}`, from: trader, to: fee.to, value: fee.value, input: fee.data, nonce: feeIdx, status: 'success' },
      treasury: cfg.feeRecipient, feeBps: cfg.feeBps, referredFeeBps: buy.feeFollowUp!.feeBps, referred: !!opts.referral,
    });
    return { notional: fill.quoteAmount, fee: fee.value, treasuryDelta: eth(feeIdx, tr, t), ethMoved, audit };
  };
  return {
    token,
    curve: curve.curve,
    feeBps: buy.feeFollowUp.feeBps,
    buy: { ethIn, ...leg(0, 1, buyFee, 'buy') },
    sell: { tokensIn: tokens, quotedNetOut: sell.quote.amountOut, ...leg(sellIdx, sellIdx + 1, sellFee, 'sell') },
    calls: all.map((x) => x.label),
  };
}

import { decodeFunctionResult, type Address, type PublicClient } from 'viem';
import { ponsCurveAbi } from './abis';
import { discoverPools } from './pools';
import { ponsBuyCapped } from './math';
import { quickBuy, quickSell } from './quick';
import { simulateCalls } from './simulate';
import type { PonsPool } from './types';

export interface CurveRoundTrip {
  token: Address;
  curve: Address;
  ethIn: bigint;
  /** Our quote and the curve's own result (simulated). */
  quotedTokens: bigint;
  simulatedTokens: bigint;
  /** What the curve pays out (before the follow-up Rushr fee, which the sell quote's amountOut is net of). */
  quotedEthBack: bigint;
  simulatedEthBack: bigint;
  buyGas: bigint;
  sellGas: bigint;
  calls: string[];
}

/**
 * Read-only round trip on a live PONS curve: quick buy, then approve + sell of exactly the tokens
 * received, all in ONE eth_simulateV1 block from `trader` with a simulated ETH balance. The sell is
 * quoted from the curve state after the buy. Nothing is signed or broadcast.
 */
export async function curveRoundTrip(client: PublicClient, token: Address, ethIn: bigint, trader: Address): Promise<CurveRoundTrip> {
  const pools = await discoverPools(client, token, { quoteAsset: 'ETH', venues: ['pons-curve'], trader });
  const curve = pools.find((p): p is PonsPool => p.venue === 'pons-curve' && !p.graduated);
  if (!curve) throw new Error(`${token}: no live curve`);
  const fund = 10n ** 18n + ethIn;
  const buy = await quickBuy(client, { token, ethWei: ethIn, trader }, { discover: { pools: [curve] }, simulate: false, acknowledgedHighRisk: true, settings: { maxTradeWei: fund }, assume: { ethWei: fund } });
  if (!buy.ok || !buy.quote) throw new Error(`${token}: buy blocked: ${buy.blockers.map((b) => b.message).join('; ')}`);
  const tokens = buy.quote.amountOut;
  // Curve state after our buy, to quote the sell exactly as the app would right after buying.
  const used = ponsBuyCapped(ethIn, curve).used;
  const net = used - (used * BigInt(curve.feeBps)) / 10_000n - (used * BigInt(curve.creatorTaxBps)) / 10_000n;
  const after: PonsPool = { ...curve, quoteReserve: curve.quoteReserve + net, tokenReserve: curve.tokenReserve - tokens, realQuoteReserve: curve.realQuoteReserve + net };
  const sell = await quickSell(client, { token, trader, amount: tokens }, { discover: { pools: [after] }, simulate: false, settings: { maxTradeWei: fund }, assume: { ethWei: fund, tokenWei: tokens } });
  if (!sell.quote) throw new Error(`${token}: sell blocked: ${sell.blockers.map((b) => b.message).join('; ')}`);
  const all = [...buy.calls, ...sell.calls];
  const sim = await simulateCalls(client, all.map((c) => ({ from: trader, to: c.to, data: c.data, value: c.value, label: c.label })), { fund: { [trader]: fund } });
  const bad = sim.calls.find((c) => !c.ok);
  if (bad) throw new Error(`${token}: ${bad.label} reverted: ${bad.error}`);
  const r = (i: number, fn: 'buy' | 'sell') => decodeFunctionResult({ abi: ponsCurveAbi, functionName: fn, data: sim.calls[i]!.returnData }) as bigint;
  return {
    token,
    curve: curve.curve,
    ethIn,
    quotedTokens: tokens,
    simulatedTokens: r(0, 'buy'),
    quotedEthBack: sell.quote.grossOut,
    simulatedEthBack: r(all.length - 1, 'sell'),
    buyGas: sim.calls[0]!.gasUsed,
    sellGas: sim.calls[all.length - 1]!.gasUsed,
    calls: all.map((c) => c.label),
  };
}

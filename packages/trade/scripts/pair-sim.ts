/**
 * Read-only: a small ETH -> pair-token curve buy and the sell of what it bought, on a live PONS curve
 * priced in another ERC-20 (default AMC, priced in ANT), in ONE eth_simulateV1 block from a fake wallet
 * funded by state override. Nothing is signed or sent.
 *
 *   pnpm --filter @rushr/trade exec tsx scripts/pair-sim.ts [token] [ethWei]
 */
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, type Address, type PublicClient } from 'viem';
import { erc20Abi } from '../src/abis';
import { robinhoodChain } from '../src/chain';
import { ponsCurveAbi } from '../src/abis';
import { NATIVE_TRANSFER_EMITTER, simulateCalls } from '../src/simulate';
import { quickBuy, quickSell } from '../src/quick';
import { finalizePairLeg, pairReceived } from '../src/pair-trade';
import { formatPairAmount } from '../src/pair-route';
import { RUSHR_TREASURY } from '../src/config';

const client = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
const token = (process.argv[2] ?? '0x7507de4f2931b1dbc04d8ec8079849abdd74aaeb') as Address;
const ethIn = BigInt(process.argv[3] ?? 2_000_000_000_000_000n); // 0.002 ETH
const trader: Address = '0x00000000000000000000000000000000b0b0b0b1';
const fund = 10n ** 18n;
const j = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

const buy = await quickBuy(client, { token, ethWei: ethIn, trader }, { acknowledgedHighRisk: true, settings: { maxTradeWei: fund }, assume: { ethWei: fund } });
console.log('buy blockers', j(buy.blockers), '\nwarnings', buy.warnings);
if (!buy.pairLegs || !buy.quote) throw new Error('not a pair route');
const L = buy.pairLegs;
console.log('buy calls', buy.calls.map((c) => c.label), 'path', L.path);
console.log(`quote: ${ethIn} wei -> ${formatPairAmount(L.pairAmount, L.pairDecimals, L.pairSymbol)} (min ${formatPairAmount(L.minPairAmount, L.pairDecimals, L.pairSymbol)}) -> ${buy.quote.amountOut} tokens (min ${buy.quote.minAmountOut}), fee ${buy.quote.fee.feeAmount} wei (${buy.quote.fee.feeBps} bps)`);

// 1) Buy as built (curve leg spends the guaranteed minimum).
const sim1 = await simulateCalls(client, buy.calls.map((c) => ({ from: trader, to: c.to, data: c.data, value: c.value, label: c.label })), { fund: { [trader]: fund } });
for (const c of sim1.calls) console.log(' ', c.label, c.ok ? 'ok' : `REVERT ${c.error}`, 'gas', c.gasUsed);
if (!sim1.ok) process.exit(1);
const urIdx = L.firstLeg;
/** The trader's pair balance right after `calls` (a balanceOf in the same simulated block). */
async function balanceAfter(calls: { to: Address; data: `0x${string}`; value: bigint; label: string }[], pair: Address): Promise<bigint> {
  const read = { from: trader, to: pair, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [trader] }), value: 0n, label: 'balanceOf' };
  const sim = await simulateCalls(client, [...calls, read].map((c) => ({ ...c, from: trader })), { fund: { [trader]: fund } });
  return BigInt(sim.calls[sim.calls.length - 1]!.returnData);
}
const fee1 = sim1.transfers.filter((t) => t.callIndex === urIdx && t.token === NATIVE_TRANSFER_EMITTER && t.to === RUSHR_TREASURY.toLowerCase()).reduce((s, t) => s + t.value, 0n);
const balAfterSwap = await balanceAfter(buy.calls.slice(0, urIdx + 1), L.pairToken);
const got = pairReceived(L, sim1.calls[urIdx]!, balAfterSwap);
console.log(`  ANT in logs ${pairReceived(L, sim1.calls[urIdx]!)} vs balance ${balAfterSwap}`);
const tokens = decodeFunctionResult({ abi: ponsCurveAbi, functionName: 'buy', data: sim1.calls[L.secondLeg]!.returnData }) as bigint;
console.log(`as built: treasury got ${fee1} wei; ${formatPairAmount(got, L.pairDecimals, L.pairSymbol)} arrived; curve gave ${tokens} tokens (>= min ${buy.quote.minAmountOut}: ${tokens >= buy.quote.minAmountOut})`);

// 2) Buy with the curve leg rebuilt from the swap leg's receipt (what the web app sends), then sell all of it.
const second = finalizePairLeg(buy, sim1.calls[urIdx]!, { balanceAfter: balAfterSwap })!;
const buyFinal = buy.calls.map((c, i) => (i === L.secondLeg ? second : c));
const sim2a = await simulateCalls(client, buyFinal.map((c) => ({ from: trader, to: c.to, data: c.data, value: c.value, label: c.label })), { fund: { [trader]: fund } });
for (const c of sim2a.calls) console.log("  fin", c.label, c.ok ? "ok" : `REVERT ${c.error}`);
const tokens2 = decodeFunctionResult({ abi: ponsCurveAbi, functionName: 'buy', data: sim2a.calls[L.secondLeg]!.returnData }) as bigint;
console.log(`finalized buy: ok ${sim2a.ok}; curve gave ${tokens2} tokens (quoted ${buy.quote.amountOut})`);

// Sell the buy's guaranteed minimum (blocks move between simulations; the curve trades live).
const sellAmount = buy.quote.minAmountOut;
const sell = await quickSell(client, { token, trader, amount: sellAmount }, { simulate: false, settings: { maxTradeWei: fund }, assume: { ethWei: fund, tokenWei: sellAmount } });
console.log('sell blockers', j(sell.blockers), 'calls', sell.calls.map((c) => c.label));
if (!sell.pairLegs || !sell.quote) throw new Error('sell not a pair route');
const S = sell.pairLegs;
console.log(`sell quote: ${sellAmount} tokens -> ${formatPairAmount(S.pairAmount, S.pairDecimals, S.pairSymbol)} -> ${sell.quote.amountOut} wei net (min ${sell.quote.minAmountOut}), fee ${sell.quote.fee.feeAmount}`);
const all = [...buyFinal, ...sell.calls];
const sim2 = await simulateCalls(client, all.map((c) => ({ from: trader, to: c.to, data: c.data, value: c.value, label: c.label })), { fund: { [trader]: fund } });
for (const [i, c] of sim2.calls.entries()) console.log(' ', i, c.label, c.ok ? 'ok' : `REVERT ${c.error}`, 'gas', c.gasUsed);
const off = buyFinal.length;
const curveSellIdx = off + S.firstLeg;
const urSellIdx = off + S.secondLeg;
const balAfterCurve = await balanceAfter([...buyFinal, ...sell.calls.slice(0, S.firstLeg + 1)], S.pairToken);
const pairFromCurve = pairReceived(S, sim2.calls[curveSellIdx]!, balAfterCurve);
// The swap leg as built spends the minimum; rebuilt from the curve leg's receipt, it spends everything.
const urFinal = finalizePairLeg(sell, sim2.calls[curveSellIdx]!, { balanceAfter: balAfterCurve })!;
const all3 = [...buyFinal, ...sell.calls.map((c, i) => (i === S.secondLeg ? urFinal : c))];
const sim3 = await simulateCalls(client, all3.map((c) => ({ from: trader, to: c.to, data: c.data, value: c.value, label: c.label })), { fund: { [trader]: fund } });
const ethBack = (sim: typeof sim3, i: number) => sim.transfers.filter((t) => t.callIndex === i && t.token === NATIVE_TRANSFER_EMITTER && t.to === trader).reduce((s, t) => s + t.value, 0n);
const feeAt = (sim: typeof sim3, i: number) => sim.transfers.filter((t) => t.callIndex === i && t.token === NATIVE_TRANSFER_EMITTER && t.to === RUSHR_TREASURY.toLowerCase()).reduce((s, t) => s + t.value, 0n);
console.log(`sell as built: ok ${sim2.ok}, ${formatPairAmount(pairFromCurve, S.pairDecimals, S.pairSymbol)} from the curve, ETH back ${ethBack(sim2, urSellIdx)}, fee ${feeAt(sim2, urSellIdx)}`);
console.log(`sell finalized: ok ${sim3.ok}, ETH back ${ethBack(sim3, urSellIdx)} (quoted net ${sell.quote.amountOut}, min ${sell.quote.minAmountOut}), fee ${feeAt(sim3, urSellIdx)} = ${(Number(feeAt(sim3, urSellIdx)) * 10_000 / Number(ethBack(sim3, urSellIdx) + feeAt(sim3, urSellIdx))).toFixed(2)} bps`);
console.log(`round trip: ${ethIn} wei in, ${ethBack(sim3, urSellIdx)} wei back`);

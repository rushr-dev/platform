/**
 * Read-only: a small ETH buy of a token whose market is priced in another token (default NVDAc, traded
 * against NVDA through the PONS hook pool), and the sell of what it bought, as multi-hop Universal Router
 * calls in ONE eth_simulateV1 block from a fake wallet funded by state override. Nothing is signed or sent.
 *
 *   pnpm --filter @rushr/trade exec tsx scripts/path-sim.ts [token] [ethWei]
 */
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain } from '../src/chain';
import { fetchApiPools } from '../src/api-pools';
import { discoverPools } from '../src/pools';
import { quickBuy, quickSell } from '../src/quick';
import { NATIVE_TRANSFER_EMITTER, simulateCalls } from '../src/simulate';
import { RUSHR_TREASURY } from '../src/config';

const client = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
const token = (process.argv[2] ?? '0x7d578ac588917519f339c70bdd991bf3aa9c0620') as Address;
const ethIn = BigInt(process.argv[3] ?? 2_000_000_000_000_000n);
const trader: Address = '0x00000000000000000000000000000000b0b0b0b3';
const fund = 10n ** 18n;
const j = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v));

const apiPools = await fetchApiPools(token);
const pools = await discoverPools(client, token, { quoteAsset: 'ETH', apiPools, trader });
const opts = { discover: { pools, apiPools }, pairApiPools: (t: Address) => fetchApiPools(t), acknowledgedHighRisk: true, settings: { maxTradeWei: fund }, assume: { ethWei: fund } };
const buy = await quickBuy(client, { token, ethWei: ethIn, trader }, opts);
console.log('buy blockers', j(buy.blockers), '\nwarnings', buy.warnings);
const q = buy.quote!;
console.log('path', q.path?.map((h) => `${h.pool.venueFeeLabel} ${h.tokenIn.slice(0, 8)}→${h.tokenOut.slice(0, 8)}`));
console.log(`buy: ${ethIn} wei -> ${q.amountOut} tokens (min ${q.minAmountOut}), fee ${q.fee.feeAmount} (${q.fee.feeBps} bps), impact ${q.priceImpactBps} bps, calls ${buy.calls.map((c) => c.label)}`);
const sell = await quickSell(client, { token, trader, amount: q.minAmountOut }, { ...opts, simulate: false, assume: { ethWei: fund, tokenWei: q.minAmountOut } });
console.log('sell blockers', j(sell.blockers), 'calls', sell.calls.map((c) => c.label));
const sq = sell.quote!;
console.log(`sell: ${q.minAmountOut} tokens -> ${sq.amountOut} wei net (min ${sq.minAmountOut}), fee ${sq.fee.feeAmount}, path ${sq.path?.length} hops`);
const all = [...buy.calls, ...sell.calls];
const sim = await simulateCalls(client, all.map((c) => ({ from: trader, to: c.to, data: c.data, value: c.value, label: c.label })), { fund: { [trader]: fund } });
for (const [i, c] of sim.calls.entries()) console.log(' ', i, c.label, c.ok ? 'ok' : `REVERT ${c.error}`, 'gas', c.gasUsed);
const eth = (i: number, to: string) => sim.transfers.filter((t) => t.callIndex === i && t.token === NATIVE_TRANSFER_EMITTER && t.to === to.toLowerCase()).reduce((a, t) => a + t.value, 0n);
const got = sim.transfers.filter((t) => t.callIndex === 0 && t.token === token.toLowerCase() && t.to === trader).reduce((a, t) => a + t.value, 0n);
const last = all.length - 1;
console.log(`buy fee to treasury ${eth(0, RUSHR_TREASURY)}; tokens received ${got} (min ${q.minAmountOut})`);
console.log(`sell: ETH back ${eth(last, trader)} (min ${sq.minAmountOut}), fee ${eth(last, RUSHR_TREASURY)} = ${((Number(eth(last, RUSHR_TREASURY)) * 10_000) / Number(eth(last, trader) + eth(last, RUSHR_TREASURY))).toFixed(2)} bps`);
console.log(`round trip: ${ethIn} in, ${eth(last, trader)} back (sold the minimum)`);

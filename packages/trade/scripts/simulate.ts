/**
 * Live check of quoting, routing and tx building against Robinhood Chain state, using only eth_call and
 * eth_simulateV1 (validation off, balances overridden). Nothing is signed or broadcast.
 *
 *   RPC_URL=... node scripts/simulate.ts [token ...]
 *
 * Without RPC_URL it reads apps/indexer/.dev.vars from RUSHR_MAIN_CHECKOUT (never printed).
 * Each token costs roughly 20-40 RPC calls.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createPublicClient, formatEther, formatUnits, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain } from '../src/chain';
import { resolveConfig } from '../src/config';
import { findBestRoute, quotePool } from '../src/quote';
import { buildSwap } from '../src/build';
import { probeTokenSafety, simulateCalls, approvalCalls, swapCall, analyzeSwapTransfers } from '../src/simulate';
import { describeCommands } from '../src/universal-router';
import { TRADE_ADDRESSES } from '../src/addresses';
import { erc20Abi } from '../src/abis';
import { fetchApiPools } from '../src/api-pools';
import type { Quote } from '../src/types';

function rpcUrl(): string {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  const main = process.env.RUSHR_MAIN_CHECKOUT;
  if (!main) throw new Error('set RPC_URL or RUSHR_MAIN_CHECKOUT');
  const vars = fs.readFileSync(path.join(main, 'apps/indexer/.dev.vars'), 'utf8');
  const m = vars.match(/^RPC_URL\s*=\s*"?([^"\n]+)"?/m);
  if (!m) throw new Error('RPC_URL not found in .dev.vars');
  return m[1]!;
}

const client = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl(), { batch: false }), batch: { multicall: true } }) as PublicClient;
// Simulated trader: a fresh address with no history; balances are overridden in the simulation only.
const simTrader: Address = '0x00000000000000000000000000000000c0ffee01';
const cfg = resolveConfig(); // defaults: 0.5% to the placeholder treasury
let createdBlock: bigint | undefined;

const DEFAULT_TOKENS: { address: Address; mainPool?: `0x${string}` }[] = [
  { address: '0x39dbed3a2bd333467115de45665cc57f813c4571', mainPool: '0xf7e4b9c0650edaac01e4f6b493344e813498c8ac14738fb1dc47b3de021e584e' }, // PONS
];

const fmtQ = (q: Quote, v: bigint) => (q.request.quoteAsset === 'USDG' ? `${formatUnits(v, 6)} USDG` : `${formatEther(v)} ETH`);

/** A wallet (no code) that currently holds at least `min` of `token`, from one recent getLogs call. */
async function findHolder(token: Address, min: bigint): Promise<Address | null> {
  const head = await client.getBlockNumber();
  const logs = await client.getLogs({ address: token, event: erc20Abi[5], fromBlock: head - 2000n, toBlock: head });
  const seen = new Set<string>();
  for (const l of logs.reverse()) {
    const to = l.args.to?.toLowerCase() as Address | undefined;
    if (!to || seen.has(to)) continue;
    seen.add(to);
    if (seen.size > 15) break;
    const [code, bal] = await Promise.all([client.getCode({ address: to }), client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [to] })]);
    if ((!code || code === '0x') && bal >= min) return to;
  }
  return null;
}

async function run(token: Address, mainPool?: `0x${string}`, quoteAsset: 'ETH' | 'USDG' = 'ETH') {
  const amountIn = quoteAsset === 'ETH' ? 10n ** 16n : 25n * 10n ** 6n;
  // USDG can't be conjured with a balance override, so USDG runs simulate from a real holder (read-only).
  const trader = quoteAsset === 'ETH' ? simTrader : await findHolder(TRADE_ADDRESSES.usdg, amountIn);
  if (!trader) return console.log(`\n=== ${token} (USDG): no USDG holder found in recent blocks, skipped`);
  console.log(`\n=== ${token} (${quoteAsset}) ===`);
  let route;
  try {
    const apiPools = await fetchApiPools(token);
    console.log(`  api pools: ${apiPools ? `${apiPools.length} rows` : 'endpoint not available, on-chain discovery only'}`);
    route = await findBestRoute(client, { side: 'buy', token, quoteAsset, amountIn, trader, slippageBps: 300 }, cfg, { mainPool, createdBlock, apiPools });
  } catch (e) {
    console.log('route:', (e as Error).message);
    return;
  }
  for (const q of route.quotes) console.log(`  quote ${q.pool.venue.padEnd(11)} ${q.pool.id.slice(0, 12)}  out ${q.amountOut}  impact ${q.priceImpactBps ?? '-'}bps  ${q.pool.venueFeeLabel}`);
  for (const f of route.failures) console.log(`  fail  ${f.pool.venue.padEnd(11)} ${f.pool.id.slice(0, 12)}  ${f.error.code}`);
  const best = route.best;
  console.log(`  best: ${best.pool.venue} ${best.pool.id.slice(0, 12)}  fee ${fmtQ(best, best.fee.feeAmount)}  min ${best.minAmountOut}`);
  if (best.pool.venue === 'pons-curve') {
    console.log('  (PONS curve: router not deployed; see contracts/ fork tests)');
    return;
  }

  // Buy, then sell what we received, in one simulated block with real (slippage) minimums.
  const buy = buildSwap(best, cfg);
  console.log('  buy commands:', describeCommands(buy.commands).join(' → '));
  const buyCalls = [...approvalCalls(buy, trader), swapCall(buy, 'buy')];
  const fund = { [trader]: 10n ** 18n };
  const first = await simulateCalls(client, buyCalls, { fund });
  const buyIdx = buyCalls.length - 1;
  const buyA = analyzeSwapTransfers(best, first.transfers.filter((t) => t.callIndex === buyIdx), cfg.feeRecipient);
  if (!first.ok) console.log(first.calls.map((c) => `    ${c.label}: ${c.ok ? "ok" : c.error}`).join("\n"));
  console.log(`  buy sim: ${first.ok ? 'OK' : 'REVERT ' + first.calls.find((c) => !c.ok)?.error}  gas ${first.calls[buyIdx]!.gasUsed}  received ${buyA.received} (quoted ${best.amountOut}, exact=${buyA.received === best.amountOut})  fee ${fmtQ(best, buyA.feePaid)} (expected ${fmtQ(best, best.fee.feeAmount)})  tax ${buyA.tokenTaxBps}bps`);
  if (!first.ok || buyA.received === 0n) return;

  let sellQ: Quote | null = null;
  try {
    sellQ = await quotePool(client, best.pool, { side: 'sell', token, quoteAsset, amountIn: buyA.received, trader, slippageBps: 500 }, cfg);
  } catch (e) {
    // e.g. launch pools with one-sided liquidity: nothing to sell into until a buy lands. The probe below
    // sells after the buy in the same simulated block.
    console.log('  sell quote at current state failed:', (e as Error).message);
  }
  if (sellQ) {
  const sell = buildSwap(sellQ, cfg);
  console.log('  sell commands:', describeCommands(sell.commands).join(' → '));
  const calls = [...buyCalls, ...approvalCalls(sell, trader), swapCall(sell, 'sell')];
  const both = await simulateCalls(client, calls, { fund });
  const sellIdx = calls.length - 1;
  const sellA = analyzeSwapTransfers(sellQ, both.transfers.filter((t) => t.callIndex === sellIdx), cfg.feeRecipient);
  console.log(`  sell sim: ${both.ok ? 'OK' : 'REVERT ' + both.calls.find((c) => !c.ok)?.error}  gas ${both.calls[sellIdx]!.gasUsed}  received ${fmtQ(sellQ, sellA.received)} (min ${fmtQ(sellQ, sellQ.minAmountOut)})  fee ${fmtQ(sellQ, sellA.feePaid)} (feeBps of gross)  tax ${sellA.tokenTaxBps}bps`);
  }

  if (quoteAsset !== 'ETH') return;
  const safety = await probeTokenSafety(client, best, cfg);
  console.log(`  safety probe: buyOk ${safety.buyOk} sellOk ${safety.sellOk} buyTax ${safety.buyTaxBps} sellTax ${safety.sellTaxBps} roundTrip ${safety.roundTripBps}bps honeypot ${safety.honeypot}`);
}

/** Pool hints from the public Rushr API (main pool id and creation block). */
async function apiHints(token: Address): Promise<{ mainPool?: `0x${string}`; createdBlock?: bigint; quote?: string }> {
  try {
    const r = await fetch(`https://api.rushr.trade/tokens/${token}`);
    const t = (await r.json()) as { main_pool?: `0x${string}`; created_block?: string; quote?: string };
    return { mainPool: t.main_pool ?? undefined, createdBlock: t.created_block ? BigInt(t.created_block) : undefined, quote: t.quote };
  } catch {
    return {};
  }
}

const args = process.argv.slice(2) as Address[];
const tokens = args.length ? args.map((a) => ({ address: a, mainPool: undefined })) : DEFAULT_TOKENS;
for (const t of tokens) {
  const hints = await apiHints(t.address);
  createdBlock = hints.createdBlock;
  const usdgQuoted = hints.quote?.toLowerCase() === TRADE_ADDRESSES.usdg;
  if (usdgQuoted) {
    await run(t.address, t.mainPool ?? hints.mainPool, 'USDG');
    continue;
  }
  await run(t.address, t.mainPool ?? hints.mainPool, 'ETH');
  if (!args.length && !process.env.ONLY_ETH) await run(t.address, t.mainPool, 'USDG');
}

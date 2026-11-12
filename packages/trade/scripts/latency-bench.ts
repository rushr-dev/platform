/**
 * Quick-trade latency, stage by stage, over the public RPC the browser uses. Read-only: quotes and
 * eth_simulateV1 from a funded address; nothing is signed or broadcast.
 *
 *   pnpm --filter @rushr/trade exec tsx scripts/latency-bench.ts [token] [runs]
 *
 * "before" replays the v0 click path (discover → quote all → re-quote → balances → simulate, then the
 * RPC calls Privy's sendTransaction makes to fill nonce/fees, then receipt polling at viem's default 4s).
 * "after" is the prebuilt path: at click time only nonce/fees from cache, sign, and one broadcast.
 */
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain } from '../src/chain';
import { prepareQuickTrade } from '../src/quick';
import { fetchApiPools } from '../src/api-pools';
import { discoverPools } from '../src/pools';
import { quotePool, rankQuotes } from '../src/quote';
import { resolveConfig } from '../src/config';
import { RUSHR_TREASURY } from '../src/config';
import { TxPipeline } from '../src/fast-send';

const client = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
const token = (process.argv[2] ?? '0x39dbed3a2bd333467115de45665cc57f813c4571') as Address;
const runs = Number(process.argv[3] ?? 5);
const trader: Address = RUSHR_TREASURY; // public EOA with ETH; only simulated from
const cfg = resolveConfig();

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
async function time<T>(f: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const r = await f();
  return [r, performance.now() - t0];
}
const rows: Record<string, number[]> = {};
const add = (k: string, ms: number) => (rows[k] ??= []).push(ms);

const hints = (await (await fetch(`https://api.rushr.trade/tokens/${token}`)).json()) as { main_pool?: `0x${string}`; created_block?: string; symbol?: string };
console.log(`token ${hints.symbol ?? token} ${token}, ${runs} runs, trader = treasury (simulation only)`);

for (let i = 0; i < runs; i++) {
  add('rpc round trip (eth_blockNumber)', (await time(() => client.getBlockNumber({ cacheTime: 0 })))[1]);
  const [apiPools, tApi] = await time(() => fetchApiPools(token));
  add('1 pools from Rushr API', tApi);
  const discover = { mainPool: hints.main_pool ?? null, createdBlock: hints.created_block ? BigInt(hints.created_block) : undefined, apiPools };
  const [pools, tDisc] = await time(() => discoverPools(client, token, { ...discover, quoteAsset: 'ETH', trader }));
  add('2 pool discovery (RPC)', tDisc);
  const tradable = pools.filter((p) => p.venue !== 'pons-curve');
  const base = { side: 'buy' as const, token, quoteAsset: 'ETH' as const, amountIn: 10n ** 16n, trader, referral: null, source: { kind: 'web' as const } };
  const [qs, tQ] = await time(async () => rankQuotes((await Promise.allSettled(tradable.map((p) => quotePool(client, p, { ...base, slippageBps: 500 }, cfg)))).flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []))));
  add('3 quote every pool', tQ);
  if (!qs.length) throw new Error('no quote');
  add('4 re-quote best at final slippage', (await time(() => quotePool(client, qs[0]!.pool, { ...base, slippageBps: 800 }, cfg)))[1]);
  add('5 balances + gas price', (await time(() => Promise.all([client.getBalance({ address: trader }), client.getGasPrice()])))[1]);
  // Whole prepare (includes the simulation) with pools given, minus the stages above ≈ simulation.
  const [t, tPrep] = await time(() => prepareQuickTrade(client, { side: 'buy', token, amountIn: 10n ** 16n, trader }, { discover: { ...discover, pools }, acknowledgedHighRisk: true, assume: { ethWei: 10n ** 18n } }));
  add('6 prepare with pools known (quote → simulate, balances in parallel)', tPrep);
  if (!t.ok) console.log('  blocked:', t.blockers.map((b) => b.code).join(','));
  // What Privy's sendTransaction does before signing (viem prepareTransactionRequest, gas given).
  add('7 Privy pre-sign fill: nonce + block/fees + priority fee', (await time(() => Promise.all([client.getTransactionCount({ address: trader, blockTag: 'pending' }), client.getBlock(), client.estimateMaxPriorityFeePerGas().catch(() => 0n)])))[1]);
  add('8 broadcast-sized round trip (eth_sendRawTransaction ≈ 1 RPC)', (await time(() => client.getChainId()))[1]);
  // After: nonce + fee cache warm (off the click path) and the sync broadcast's round trip (an
  // undecodable payload, rejected by the node: same path, never a real tx).
  const pipe = new TxPipeline(client, trader);
  add('9 TxPipeline.warm (nonce + base fee, background)', (await time(() => pipe.warm()))[1]);
  add('10 eth_sendRawTransactionSync round trip (rejected probe)', (await time(() => client.request({ method: 'eth_sendRawTransactionSync' as 'eth_sendRawTransaction', params: ['0x02'] }).catch(() => null)))[1]);
}

// Chain cadence: blocks over ~6s.
const b0 = await client.getBlockNumber({ cacheTime: 0 });
const s0 = performance.now();
await new Promise((r) => setTimeout(r, 6_000));
const b1 = await client.getBlockNumber({ cacheTime: 0 });
const blockMs = (performance.now() - s0) / Math.max(1, Number(b1 - b0));

// eth_sendRawTransactionSync (EIP-7966): probe with an undecodable payload (never a real tx).
let syncSupport = 'unknown';
try {
  await client.request({ method: 'eth_sendRawTransactionSync' as 'eth_sendRawTransaction', params: ['0x00'] });
} catch (e) {
  const m = String((e as Error).message).replace(/https?:\/\/\S+/g, '<rpc>');
  syncSupport = /not found|does not exist|not available|unsupported|method/i.test(m) && !/decode|rlp|typed/i.test(m) ? `no (${m.split('\n')[0]!.slice(0, 90)})` : `likely yes (${m.split('\n')[0]!.slice(0, 90)})`;
}

// Privy API round trip (TLS reuse after the first).
const privy: number[] = [];
for (let i = 0; i < 4; i++) privy.push((await time(() => fetch('https://auth.privy.io/api/v1/apps/healthz', { method: 'GET' }).then((r) => r.arrayBuffer()).catch(() => null)))[1]);

console.log('\nstage (median ms over runs)');
for (const [k, v] of Object.entries(rows)) console.log(`  ${k.padEnd(62)} ${med(v).toFixed(0).padStart(6)}   [${v.map((x) => x.toFixed(0)).join(', ')}]`);
console.log(`  ${'Privy API round trip (signing ≈ 1–2 of these + enclave time)'.padEnd(62)} ${med(privy.slice(1)).toFixed(0).padStart(6)}`);
console.log(`\nblock interval ≈ ${blockMs.toFixed(0)} ms; eth_sendRawTransactionSync: ${syncSupport}`);

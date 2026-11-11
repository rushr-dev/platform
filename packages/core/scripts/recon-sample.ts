/**
 * Pull recent logs for every registry entry and print launches and trade counts.
 * Usage: pnpm --filter @rushr/core recon [blocks=3000]
 * RPC: $RPC_URL, else apps/indexer/.dev.vars, else the public RPC.
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, http, decodeEventLog, type Address, type Log } from 'viem';
import {
  ABIS,
  LAUNCHPADS,
  ROBINHOOD_CHAIN,
  TOPICS,
  UNISWAP,
  launchpadForHook,
} from '../src/chain/robinhood.ts';

function rpcUrl(): string {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  try {
    const vars = readFileSync(new URL('../../../apps/indexer/.dev.vars', import.meta.url), 'utf8');
    const m = vars.match(/^RPC_URL=(.+)$/m);
    if (m?.[1]) return m[1].trim();
  } catch {}
  return ROBINHOOD_CHAIN.publicRpc;
}

const client = createPublicClient({ transport: http(rpcUrl()) });
const span = BigInt(process.argv[2] ?? 3000);
const head = await client.getBlockNumber();
const fromBlock = head - span;

async function logs(params: { address?: Address | Address[]; topics?: (`0x${string}` | null)[] }) {
  const out: Log[] = [];
  for (let b = fromBlock; b < head; b += 1000n) {
    const to = b + 999n > head ? head : b + 999n;
    out.push(
      ...((await client.request({
        method: 'eth_getLogs',
        params: [{ fromBlock: `0x${b.toString(16)}`, toBlock: `0x${to.toString(16)}`, ...params }],
      })) as Log[]),
    );
  }
  return out;
}

const addr = (topic: string | undefined) => `0x${(topic ?? '').slice(26)}` as Address;

console.log(`Robinhood Chain head ${head}, scanning ${span} blocks (~${(Number(span) * ROBINHOOD_CHAIN.blockTimeSeconds / 60).toFixed(1)} min)\n`);

// 1. v4 pool inits, classified by hook
const inits = await logs({
  address: UNISWAP.v4.poolManager,
  topics: [`0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438`],
});
const byPad = new Map<string, number>();
for (const l of inits) {
  const ev = decodeEventLog({ abi: ABIS.v4PoolManager, data: l.data, topics: l.topics as never });
  if (ev.eventName !== 'Initialize') continue;
  const pad = launchpadForHook(ev.args.hooks) ?? 'uniswap-v4';
  byPad.set(pad, (byPad.get(pad) ?? 0) + 1);
}
console.log('v4 pool inits by launchpad:', Object.fromEntries(byPad));

// 2. Doppler creates
const doppler = LAUNCHPADS.find((l) => l.id === 'doppler')!;
const dLogs = await logs({ address: doppler.launcher });
for (const l of dLogs.slice(-3)) {
  const ev = decodeEventLog({ abi: ABIS.dopplerAirlock, data: l.data, topics: l.topics as never });
  console.log(`doppler ${ev.eventName}`, ev.args, l.transactionHash);
}
console.log(`doppler events: ${dLogs.length}`);

// 3. lift.fun launches (name/symbol from data)
const lift = await logs({ address: LAUNCHPADS.find((l) => l.id === 'liftfun')!.launcher, topics: [TOPICS.liftLaunch] });
for (const l of lift.slice(-3)) console.log(`lift.fun launch token=${addr(l.topics[1])} creator=${addr(l.topics[2])} tx=${l.transactionHash}`);
console.log(`lift.fun launches: ${lift.length}`);

// 4. PONS launches + curve trades
const pons = await logs({ address: LAUNCHPADS.find((l) => l.id === 'pons')!.launcher, topics: [TOPICS.ponsLaunch] });
for (const l of pons.slice(-3)) console.log(`pons launch token=${addr(l.topics[1])} curve=${addr(l.topics[2])} tx=${l.transactionHash}`);
const ponsBuys = await logs({ topics: [TOPICS.ponsBuy] });
const ponsSells = await logs({ topics: [TOPICS.ponsSell] });
console.log(`pons launches: ${pons.length}, curve buys: ${ponsBuys.length}, sells: ${ponsSells.length}`);

// 5. v4 swaps
const swaps = await logs({
  address: UNISWAP.v4.poolManager,
  topics: [`0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f`],
});
console.log(`v4 swaps: ${swaps.length}`);

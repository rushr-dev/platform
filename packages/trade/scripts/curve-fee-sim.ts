/**
 * Read-only: the follow-up Rushr fee on live PONS curves (eth_simulateV1, nothing signed or sent).
 * Prints, per token, what the curve took / paid, the fee transfer built from the simulated receipt and
 * the treasury's simulated ETH delta. See src/curve-fee-sim.ts.
 *
 *   pnpm --filter @rushr/trade exec tsx scripts/curve-fee-sim.ts [token…] [--eth 0.01] [--n 2] [--referred]
 */
import { createPublicClient, formatEther, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain } from '../src/chain';
import { curveFeeRoundTrip } from '../src/curve-fee-sim';

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const ethIn = BigInt(Math.round(Number(opt('--eth') ?? '0.01') * 1e6)) * 10n ** 12n;
const n = Number(opt('--n') ?? 2);
const referral = args.includes('--referred') ? { referrer: '0x000000000000000000000000000000000000dEaD' as Address } : null;
const client = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
const trader: Address = '0x00000000000000000000000000000000b0b0b0b0';

let tokens = args.filter((a) => /^0x[0-9a-fA-F]{40}$/.test(a)) as Address[];
if (!tokens.length) {
  const res = await fetch('https://api.rushr.trade/tokens?column=new&launchpad=pons&limit=40');
  const { tokens: list } = (await res.json()) as { tokens: { address: Address; volume_24h_usd: number | null }[] };
  tokens = list.sort((a, b) => (b.volume_24h_usd ?? 0) - (a.volume_24h_usd ?? 0)).slice(0, 10).map((t) => t.address);
}
let done = 0;
for (const t of tokens) {
  if (done === n) break;
  try {
    const r = await curveFeeRoundTrip(client, t, ethIn, trader, { referral });
    done++;
    console.log(`${t} (curve ${r.curve}), ${r.feeBps} bps`);
    console.log(`  buy  ${formatEther(r.buy.ethIn)} ETH: curve took ${formatEther(r.buy.notional)}; fee tx ${formatEther(r.buy.fee)}; treasury +${formatEther(r.buy.treasuryDelta)} ETH [${r.buy.audit.flags.join(', ') || 'ok'}]`);
    console.log(`  sell ${formatEther(r.sell.tokensIn)} tokens: curve paid ${formatEther(r.sell.notional)} (quoted net ${formatEther(r.sell.quotedNetOut)}); fee tx ${formatEther(r.sell.fee)}; treasury +${formatEther(r.sell.treasuryDelta)} ETH [${r.sell.audit.flags.join(', ') || 'ok'}]`);
  } catch (e) {
    console.log(`${t}: skipped (${(e as Error).message.slice(0, 100)})`);
  }
}

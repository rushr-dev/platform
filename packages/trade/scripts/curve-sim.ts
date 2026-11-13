/**
 * Read-only: quick buy then sell on live PONS curves in one eth_simulateV1 block (simulated balance).
 *   pnpm --filter @rushr/trade exec tsx scripts/curve-sim.ts <token> [token…] [--eth 0.01]
 */
import { createPublicClient, formatEther, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain } from '../src/chain';
import { curveRoundTrip } from '../src/curve-sim';
const client = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
const args = process.argv.slice(2);
const i = args.indexOf('--eth');
const eth = BigInt(Math.round(Number(i >= 0 ? args[i + 1] : '0.01') * 1e6)) * 10n ** 12n;
const tokens = args.filter((a, j) => a.startsWith('0x') && (i < 0 || j !== i + 1)) as Address[];
for (const t of tokens) {
  try {
    const r = await curveRoundTrip(client, t, eth, '0x00000000000000000000000000000000b0b0b0b0');
    const sym = ((await (await fetch(`https://api.rushr.trade/tokens/${t}`)).json()) as { symbol?: string }).symbol ?? t;
    console.log(`${sym.padEnd(8)} buy ${formatEther(eth)} ETH → quoted ${formatEther(r.quotedTokens)} / curve ${formatEther(r.simulatedTokens)} tokens ${r.quotedTokens === r.simulatedTokens ? '(exact)' : '(DIFF)'}; sell all → quoted ${formatEther(r.quotedEthBack)} / curve ${formatEther(r.simulatedEthBack)} ETH ${r.quotedEthBack === r.simulatedEthBack ? '(exact)' : '(DIFF)'}; gas ${r.buyGas}/${r.sellGas}; calls ${r.calls.join(' → ')}`);
  } catch (e) {
    console.log(t, 'ERR', String((e as Error).message).replace(/https?:\/\/\S+/g, '').slice(0, 200));
  }
}

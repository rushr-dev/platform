/**
 * Read-only: Universal Router buy then sell on live tokens in one eth_simulateV1 block, showing the ETH
 * the treasury receives in each and the fee audit's verdict. Nothing is signed or sent.
 *   pnpm --filter @rushr/trade exec tsx scripts/fee-sim.ts <token> [token…] [--eth 0.01]
 */
import { createPublicClient, formatEther, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain } from '../src/chain';
import { fetchApiPools } from '../src/api-pools';
import { feeRoundTrip } from '../src/fee-sim';

const client = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
const args = process.argv.slice(2);
const i = args.indexOf('--eth');
const eth = BigInt(Math.round(Number(i >= 0 ? args[i + 1] : '0.01') * 1e6)) * 10n ** 12n;
const tokens = args.filter((a, j) => a.startsWith('0x') && (i < 0 || j !== i + 1)) as Address[];
for (const token of tokens) {
  try {
    const h = (await (await fetch(`https://api.rushr.trade/tokens/${token}`, { signal: AbortSignal.timeout(15_000) })).json()) as { symbol?: string; main_pool?: `0x${string}` };
    const r = await feeRoundTrip(client, token, eth, '0x00000000000000000000000000000000b0b0b0b0', { discover: { mainPool: h.main_pool ?? null, apiPools: await fetchApiPools(token) } });
    const f = (a: typeof r.buy.audit) => `${a.feeBps} bps (expected ${a.expectedBps}, calldata ${a.calldataBps})${a.flags.length ? ` FLAGS ${a.flags.join(',')}` : ' ok'}`;
    console.log(`${(h.symbol ?? token).padEnd(8)} ${r.venue}`);
    console.log(`  buy  ${formatEther(eth)} ETH: treasury +${formatEther(r.buy.treasuryDelta)} ETH (quoted fee ${formatEther(r.buy.expectedFee)}), audit ${f(r.buy.audit)}`);
    console.log(`  sell ${formatEther(r.sell.tokensIn)} tokens: treasury +${formatEther(r.sell.treasuryDelta)} ETH (quoted fee ${formatEther(r.sell.quotedFee)}), audit ${f(r.sell.audit)}`);
  } catch (e) {
    console.log(token, 'ERR', String((e as Error).message).replace(/https?:\/\/\S+/g, '').slice(0, 240));
  }
}

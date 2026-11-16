/**
 * Runs the web app's buy→sell safety probe on the most active tokens and reports which ones the probe
 * can't verify (buyOk false or an error). The web app blocks buys on those (fail closed), so this list
 * should be empty or only real problems. Public RPC, nothing signed.
 *
 *   pnpm --filter @rushr/trade exec tsx scripts/probe-survey.ts [limit]
 */
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain } from '../src/chain';
import { quickBuy } from '../src/quick';
import { probeTokenSafety } from '../src/simulate';
import { fetchApiPools } from '../src/api-pools';
import { resolveConfig } from '../src/config';

const client = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
const GUEST: Address = '0x00000000000000000000000000000000b0b0b0b0';
const limit = Number(process.argv[2] ?? 40);
const list = (await (await fetch(`https://api.rushr.trade/tokens?column=${process.argv[3] ?? "migrated"}&limit=${limit}`)).json()) as { tokens?: { address: Address; symbol: string; status: string }[] } | { address: Address; symbol: string; status: string }[];
const tokens = Array.isArray(list) ? list : (list.tokens ?? []);
let bad = 0;
for (const t of tokens) {
  try {
    const buy = await quickBuy(client, { token: t.address, ethWei: 10n ** 15n, trader: GUEST }, { discover: { apiPools: await fetchApiPools(t.address) }, assume: { ethWei: 10n ** 18n }, acknowledgedHighRisk: true, simulate: false });
    if (!buy.quote) { console.log(`skip ${t.symbol}: ${buy.blockers.map((b) => b.code).join(',')}`); continue; }
    const p = await probeTokenSafety(client, buy.quote, resolveConfig());
    const flag = !p.buyOk ? 'UNVERIFIED' : p.honeypot ? 'HONEYPOT' : 'ok';
    if (flag !== 'ok') bad++;
    console.log(`${flag.padEnd(10)} ${t.symbol.padEnd(12)} ${t.status} sellOk=${p.sellOk} tax=${p.buyTaxBps}/${p.sellTaxBps} ${p.error ? p.error.slice(0, 90) : ''}`);
  } catch (e) {
    bad++;
    console.log(`THROW      ${t.symbol.padEnd(12)} ${(e as Error).message.slice(0, 120)}`);
  }
}
console.log(`\n${tokens.length} tokens, ${bad} not ok`);

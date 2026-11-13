/**
 * LIVE (read-only): the beta fee on Universal Router trades. For two current graduated tokens, a quick
 * buy then a sell in one eth_simulateV1 block from a test address with a simulated balance; the treasury
 * must receive exactly the quoted 25 bps on the buy and 25 bps of the actual gross output on the sell,
 * and the fee audit must pass. Tokens are picked from the Rushr API at run time (pools get rugged).
 * Nothing is signed or broadcast. Skipped unless LIVE=1:  pnpm --filter @rushr/trade test:live
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain } from '../../src/chain';
import { fetchApiPools } from '../../src/api-pools';
import { feeRoundTrip } from '../../src/fee-sim';

const LIVE = process.env.LIVE === '1';
const client = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
const trader: Address = '0x00000000000000000000000000000000b0b0b0b0';

describe.skipIf(!LIVE)('live beta fee (Universal Router)', () => {
  it('buy and sell on 2 graduated tokens: the treasury receives 25 bps, the audit passes', async () => {
    const res = await fetch('https://api.rushr.trade/tokens?column=migrated&limit=40', { signal: AbortSignal.timeout(15_000) });
    const { tokens } = (await res.json()) as { tokens: { address: Address; quote_symbol: string; volume_24h_usd: number | null }[] };
    const picks = tokens.filter((t) => t.quote_symbol === 'ETH').sort((a, b) => (b.volume_24h_usd ?? 0) - (a.volume_24h_usd ?? 0));
    let checked = 0;
    for (const t of picks) {
      if (checked === 2) break;
      const h = (await (await fetch(`https://api.rushr.trade/tokens/${t.address}`, { signal: AbortSignal.timeout(15_000) })).json()) as { main_pool?: `0x${string}` };
      const r = await feeRoundTrip(client, t.address, 10n ** 16n, trader, { discover: { mainPool: h.main_pool ?? null, apiPools: await fetchApiPools(t.address) } }).catch(() => null);
      if (!r) continue; // withdrawn liquidity, hooks that reject a side, …
      expect(r.buy.treasuryDelta, t.address).toBe(25n * 10n ** 12n); // 0.25% of 0.01 ETH
      expect(r.buy.audit.flags, t.address).toEqual([]);
      expect(r.sell.audit.flags, t.address).toEqual([]);
      expect(r.sell.audit.calldataBps).toBe(25);
      expect(r.sell.treasuryDelta).toBe(r.sell.audit.fee);
      checked++;
    }
    expect(checked).toBe(2);
  }, 180_000);
});

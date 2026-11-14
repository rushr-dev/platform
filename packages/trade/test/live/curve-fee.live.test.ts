/**
 * LIVE (read-only): the follow-up Rushr fee on current PONS curve tokens. For each, eth_simulateV1 runs
 * [curve buy, fee transfer, approve, curve sell, fee transfer] from a test address with a simulated
 * balance, with each fee built from the trade's simulated receipt the way the app builds it. The
 * treasury must receive exactly the beta rate of what the curve took or paid. Nothing is signed or
 * broadcast. Skipped unless LIVE=1:
 *
 *   pnpm --filter @rushr/trade test:live
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain } from '../../src/chain';
import { DEFAULT_TRADE_CONFIG } from '../../src/config';
import { curveFeeRoundTrip } from '../../src/curve-fee-sim';

const LIVE = process.env.LIVE === '1';
const client = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
const trader: Address = '0x00000000000000000000000000000000b0b0b0b0';

async function liveCurveTokens(n: number): Promise<Address[]> {
  const res = await fetch('https://api.rushr.trade/tokens?column=new&launchpad=pons&limit=40', { signal: AbortSignal.timeout(15_000) });
  const { tokens } = (await res.json()) as { tokens: { address: Address; volume_24h_usd: number | null }[] };
  return tokens.sort((a, b) => (b.volume_24h_usd ?? 0) - (a.volume_24h_usd ?? 0)).slice(0, n).map((t) => t.address);
}

describe.skipIf(!LIVE)('live curve follow-up fee', () => {
  it('treasury receives exactly the beta rate on 2 live curves, buy and sell', async () => {
    const bps = BigInt(DEFAULT_TRADE_CONFIG.feeBps);
    let checked = 0;
    for (const t of await liveCurveTokens(8)) {
      if (checked === 2) break;
      const r = await curveFeeRoundTrip(client, t, 10n ** 16n, trader).catch((e: Error) => (/no live curve|SNIPE|snipe tax|another token/.test(e.message) ? null : Promise.reject(e)));
      if (!r) continue;
      expect(r.calls).toEqual(['swap', 'Rushr fee', 'approve token for the curve', 'swap', 'Rushr fee']);
      // Buy: the curve took the whole amount; the fee is on top of it.
      expect(r.buy.notional, t).toBe(10n ** 16n);
      expect(r.buy.ethMoved, t).toBe(r.buy.notional);
      expect(r.buy.treasuryDelta, t).toBe((r.buy.notional * bps) / 10_000n);
      // Sell: the fee is on what the curve actually paid; "you receive" was quoted net of it.
      expect(r.sell.ethMoved, t).toBe(r.sell.notional);
      expect(r.sell.treasuryDelta, t).toBe((r.sell.notional * bps) / 10_000n);
      expect(r.sell.quotedNetOut, t).toBe(r.sell.notional - r.sell.treasuryDelta);
      expect([r.buy.audit.flags, r.sell.audit.flags], t).toEqual([[], []]);
      checked++;
    }
    expect(checked).toBe(2);
  }, 120_000);
});

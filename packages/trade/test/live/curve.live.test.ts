/**
 * LIVE (read-only): direct PONS curve trades on current curve tokens. For each, a quick buy then a sell
 * of exactly the tokens received, in one eth_simulateV1 block from a test address with a simulated
 * ETH balance; our quotes must equal what the curve returns, to the wei. Tokens are picked from the
 * Rushr API at run time (curves graduate). Nothing is signed or broadcast. Skipped unless LIVE=1:
 *
 *   pnpm --filter @rushr/trade test:live
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain } from '../../src/chain';
import { curveRoundTrip } from '../../src/curve-sim';
import { discoverPools } from '../../src/pools';
import { quickBuy } from '../../src/quick';
import type { PonsPool } from '../../src/types';

const LIVE = process.env.LIVE === '1';
const client = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
const trader: Address = '0x00000000000000000000000000000000b0b0b0b0';

async function liveCurveTokens(n: number): Promise<Address[]> {
  const res = await fetch('https://api.rushr.trade/tokens?column=new&launchpad=pons&limit=40', { signal: AbortSignal.timeout(15_000) });
  const { tokens } = (await res.json()) as { tokens: { address: Address; volume_24h_usd: number | null }[] };
  return tokens
    .sort((a, b) => (b.volume_24h_usd ?? 0) - (a.volume_24h_usd ?? 0))
    .slice(0, n)
    .map((t) => t.address);
}

describe.skipIf(!LIVE)('live PONS curve trades', () => {
  it('buy then sell on 3 live curves: quotes equal the curve results to the wei', async () => {
    const tokens = await liveCurveTokens(6);
    let checked = 0;
    for (const t of tokens) {
      if (checked === 3) break;
      const r = await curveRoundTrip(client, t, 10n ** 16n, trader).catch((e: Error) => (/no live curve|SNIPE|another token|snipe tax/.test(e.message) ? null : Promise.reject(e)));
      if (!r) continue;
      expect(r.simulatedTokens, t).toBe(r.quotedTokens);
      expect(r.simulatedEthBack, t).toBe(r.quotedEthBack);
      expect(r.calls).toEqual(['swap', 'approve token for the curve', 'swap']);
      checked++;
    }
    expect(checked).toBe(3);
  }, 120_000);

  it('a buy larger than what is left completes the curve: capped at the remaining tokens, refund shown', async () => {
    // The most-bonded of the current curves, bought 0.05 ETH past what it still needs.
    const curves = (await Promise.all((await liveCurveTokens(10)).map((t) => discoverPools(client, t, { quoteAsset: 'ETH', venues: ['pons-curve'], trader }))))
      .flat()
      .filter((p): p is PonsPool => p.venue === 'pons-curve' && !p.graduated && p.nativeQuote !== false && p.graduationThreshold > p.realQuoteReserve)
      .sort((a, b) => Number(a.graduationThreshold - a.realQuoteReserve - (b.graduationThreshold - b.realQuoteReserve)));
    const curve = curves[0];
    if (!curve) return;
    const room = curve.graduationThreshold - curve.realQuoteReserve;
    const ethIn = (room * 10_000n) / BigInt(10_000 - curve.feeBps - curve.creatorTaxBps) + 5n * 10n ** 16n;
    const big = await quickBuy(client, { token: curve.token, ethWei: ethIn, trader }, { discover: { pools: [curve] }, acknowledgedHighRisk: true, settings: { maxTradeWei: 10n ** 20n }, assume: { ethWei: 10n ** 20n } });
    // Completing a curve moves the price a lot; the 30% impact guard may fire, which is intended.
    expect(big.blockers.filter((b) => b.code !== 'HIGH_IMPACT'), JSON.stringify(big.blockers)).toEqual([]);
    expect(big.quote!.amountOut).toBe(curve.sellableTokens);
    expect(big.quote!.expectedRefund).toBeGreaterThan(0n);
    expect(big.warnings.join(' ')).toContain('completes the bonding curve');
  }, 120_000);
});

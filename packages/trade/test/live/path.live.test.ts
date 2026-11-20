/**
 * LIVE (read-only): a graduated token whose market is priced in another token (NVDAc, traded against NVDA
 * through the PONS hook pool) bought and sold with ETH as multi-hop Universal Router calls, in one
 * eth_simulateV1 block from a fake wallet funded by state override, plus the buy→sell safety probe the web
 * app runs before buys. Nothing is signed or broadcast. Skipped unless LIVE=1. scripts/path-sim.ts prints details.
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain } from '../../src/chain';
import { fetchApiPools } from '../../src/api-pools';
import { RUSHR_TREASURY, resolveConfig } from '../../src/config';
import { discoverPools } from '../../src/pools';
import { quickBuy, quickSell } from '../../src/quick';
import { NATIVE_TRANSFER_EMITTER, probeTokenSafety, simulateCalls } from '../../src/simulate';

const LIVE = process.env.LIVE === '1';
const client = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
const NVDAC: Address = '0x7d578ac588917519f339c70bdd991bf3aa9c0620';
const trader: Address = '0x00000000000000000000000000000000b0b0b0b4';
const fund = 10n ** 18n;

describe.skipIf(!LIVE)('live multi-hop route (NVDAc priced in NVDA)', () => {
  it('buys and sells with ETH in one call each: the fee in ETH, minimums met, the safety probe passes', async () => {
    const apiPools = await fetchApiPools(NVDAC);
    const pools = await discoverPools(client, NVDAC, { quoteAsset: 'ETH', apiPools, trader });
    const opts = { discover: { pools, apiPools }, pairApiPools: (t: Address) => fetchApiPools(t), acknowledgedHighRisk: true, settings: { maxTradeWei: fund, slippageBps: 1_500 }, assume: { ethWei: fund } }; // wide: NVDAc can move 10% while the public RPC answers
    const buy = await quickBuy(client, { token: NVDAC, ethWei: 2n * 10n ** 15n, trader }, opts);
    expect(buy.blockers, JSON.stringify(buy.blockers)).toEqual([]);
    const q = buy.quote!;
    expect(q.path!.length).toBeGreaterThanOrEqual(2);
    expect(q.path![q.path!.length - 1]!.tokenOut).toBe(NVDAC);
    expect(buy.calls.map((c) => c.label)).toEqual(['swap']);
    const sell = await quickSell(client, { token: NVDAC, trader, amount: q.minAmountOut }, { ...opts, simulate: false, assume: { ethWei: fund, tokenWei: q.minAmountOut } });
    expect(sell.blockers).toEqual([]);
    const all = [...buy.calls, ...sell.calls];
    const sim = await simulateCalls(client, all.map((c) => ({ from: trader, to: c.to, data: c.data, value: c.value, label: c.label })), { fund: { [trader]: fund } });
    expect(sim.ok, sim.calls.filter((c) => !c.ok).map((c) => `${c.label}: ${c.error}`).join('; ')).toBe(true);
    const eth = (i: number, to: string) => sim.transfers.filter((t) => t.callIndex === i && t.token === NATIVE_TRANSFER_EMITTER && t.to === to.toLowerCase()).reduce((a, t) => a + t.value, 0n);
    const got = sim.transfers.filter((t) => t.callIndex === 0 && t.token === NVDAC && t.to === trader).reduce((a, t) => a + t.value, 0n);
    expect(eth(0, RUSHR_TREASURY)).toBe(q.fee.feeAmount);
    expect(got).toBeGreaterThanOrEqual(q.minAmountOut);
    const last = all.length - 1;
    expect(eth(last, trader)).toBeGreaterThanOrEqual(sell.quote!.minAmountOut);
    expect(Math.round((Number(eth(last, RUSHR_TREASURY)) * 10_000) / Number(eth(last, trader) + eth(last, RUSHR_TREASURY)))).toBe(sell.quote!.fee.feeBps);

    const probe = await probeTokenSafety(client, { ...q, request: { ...q.request, trader: '0x0000000000000000000000000000000000000001' } }, resolveConfig());
    expect(probe).toMatchObject({ buyOk: true, sellOk: true, honeypot: false });
  }, 120_000);
});

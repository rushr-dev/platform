/**
 * LIVE (read-only): a curve priced in another ERC-20 (AMC, priced in ANT) bought and sold with ETH, in one
 * eth_simulateV1 block from a fake wallet funded by state override. Nothing is signed or broadcast.
 * Skipped unless LIVE=1 (pnpm --filter @rushr/trade test:live). scripts/pair-sim.ts prints the details.
 */
import { describe, expect, it } from 'vitest';
import { createPublicClient, encodeFunctionData, http, type Address, type PublicClient } from 'viem';
import { robinhoodChain } from '../../src/chain';
import { erc20Abi } from '../../src/abis';
import { RUSHR_TREASURY } from '../../src/config';
import { quickBuy, quickSell, type WalletCall } from '../../src/quick';
import { finalizePairLeg, pairReceived } from '../../src/pair-trade';
import { NATIVE_TRANSFER_EMITTER, simulateCalls } from '../../src/simulate';

const LIVE = process.env.LIVE === '1';
const client = createPublicClient({ chain: robinhoodChain, transport: http(), batch: { multicall: true } }) as PublicClient;
const AMC: Address = '0x7507de4f2931b1dbc04d8ec8079849abdd74aaeb';
const trader: Address = '0x00000000000000000000000000000000b0b0b0b2';
const fund = 10n ** 18n;
const sim = (calls: WalletCall[], extra: { to: Address; data: `0x${string}` }[] = [], blockTag?: `0x${string}`) =>
  simulateCalls(client, [...calls.map((c) => ({ from: trader, to: c.to, data: c.data, value: c.value, label: c.label })), ...extra.map((e) => ({ from: trader, ...e, label: 'read' }))], { fund: { [trader]: fund }, blockTag });

const fee = (s: Awaited<ReturnType<typeof sim>>, i: number) => s.transfers.filter((t) => t.callIndex === i && t.token === NATIVE_TRANSFER_EMITTER && t.to === RUSHR_TREASURY.toLowerCase()).reduce((a, t) => a + t.value, 0n);
const failed = (s: Awaited<ReturnType<typeof sim>>) => s.calls.filter((c) => !c.ok).map((c) => `${c.label}: ${c.error}`).join('; ');
/** Each simulation runs on a newer block and ANT trades every few seconds: a leg rebuilt from one block is retried on a fresh one. */
async function retry<T>(n: number, f: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= n) throw e;
    }
  }
}

describe.skipIf(!LIVE)('live pair-token curve (AMC priced in ANT)', () => {
  it('buy then sell with ETH, as built, in one block: the fee in ETH inside both swap legs, minimums met', async () => {
    const buy = await quickBuy(client, { token: AMC, ethWei: 2n * 10n ** 15n, trader }, { acknowledgedHighRisk: true, settings: { maxTradeWei: fund }, assume: { ethWei: fund } });
    if (buy.blockers.some((b) => b.code === 'CURVE_GRADUATED')) return; // AMC moved on
    expect(buy.blockers, JSON.stringify(buy.blockers)).toEqual([]);
    expect(buy.calls.map((c) => c.label)).toEqual(['approve pair token for the curve', 'swap', 'curve swap']);
    const L = buy.pairLegs!;
    const sell = await quickSell(client, { token: AMC, trader, amount: buy.quote!.minAmountOut }, { simulate: false, settings: { maxTradeWei: fund }, assume: { ethWei: fund, tokenWei: buy.quote!.minAmountOut } });
    expect(sell.blockers).toEqual([]);
    const S = sell.pairLegs!;
    const all = await sim([...buy.calls, ...sell.calls]);
    expect(all.ok, failed(all)).toBe(true);
    expect(fee(all, L.firstLeg)).toBe(buy.quote!.fee.feeAmount);
    const sellIdx = buy.calls.length + S.secondLeg;
    const back = all.transfers.filter((t) => t.callIndex === sellIdx && t.token === NATIVE_TRANSFER_EMITTER && t.to === trader).reduce((a, t) => a + t.value, 0n);
    expect(back).toBeGreaterThanOrEqual(sell.quote!.minAmountOut);
    const sellFee = fee(all, sellIdx);
    expect(Math.round((Number(sellFee) * 10_000) / Number(back + sellFee))).toBe(S.feeBps);
  }, 120_000);

  it('the curve leg rebuilt from what the swap leg delivered spends all of it (balance, not the scaled log)', async () => {
    const buy = await quickBuy(client, { token: AMC, ethWei: 2n * 10n ** 15n, trader }, { acknowledgedHighRisk: true, simulate: false, settings: { maxTradeWei: fund }, assume: { ethWei: fund } });
    if (!buy.pairLegs) return;
    const L = buy.pairLegs;
    const balOf = { to: L.pairToken, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [trader] }) };
    await retry(2, async () => {
      // Both simulations on the same block, as the app rebuilds from the receipt of the block the swap landed in.
      const block = `0x${(await client.getBlockNumber()).toString(16)}` as const;
      const first = await sim(buy.calls.slice(0, L.firstLeg + 1), [balOf], block);
      const after = BigInt(first.calls[first.calls.length - 1]!.returnData);
      const next = finalizePairLeg(buy, first.calls[L.firstLeg]!, { balanceAfter: after })!;
      const done = await sim([...buy.calls.slice(0, L.firstLeg + 1), next], [balOf], block);
      if (!done.ok) throw new Error(failed(done));
      // Nothing left over (a few wei of scaled rounding at most), and the scaled log overstated the balance.
      expect(BigInt(done.calls[done.calls.length - 1]!.returnData)).toBeLessThan(after / 1_000n);
      expect(pairReceived(L, first.calls[L.firstLeg]!)).toBeGreaterThanOrEqual(after);
    });
  }, 120_000);
});

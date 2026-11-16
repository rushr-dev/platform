// $RUSHR creator tax on /transparency (src/creator-tax.ts): escrow log tally and the response block.
import { describe, expect, it } from 'vitest';
import { CLAIMED_TOPIC, CREDITED_TOPIC, RUSHR_LAUNCH, creatorTaxBody, emptyTally, tallyEscrowLogs, type CreatorTaxLive } from '../src/creator-tax';

const E18 = 10n ** 18n;
const w = (a: string) => '0x' + a.slice(2).padStart(64, '0');
const amt = (v: bigint) => '0x' + v.toString(16).padStart(64, '0');
let n = 0;
const credited = (from: string, v: bigint, block: bigint, account: string = RUSHR_LAUNCH.creator) => ({
  topics: [CREDITED_TOPIC, w(account), w(from)], data: amt(v), blockNumber: '0x' + block.toString(16), transactionHash: '0x' + (++n).toString(16).padStart(64, '0'),
});
const claimed = (v: bigint, block: bigint) => ({
  topics: [CLAIMED_TOPIC, w(RUSHR_LAUNCH.creator)], data: amt(v), blockNumber: '0x' + block.toString(16),
  blockTimestamp: '0x' + (1_800_000_000).toString(16), transactionHash: '0x' + (++n).toString(16).padStart(64, '0'),
});
const B = RUSHR_LAUNCH.launchBlock;

describe('tallyEscrowLogs', () => {
  it('splits credits by source, records claims, and skips other accounts and blocks outside the range', () => {
    const t = tallyEscrowLogs(emptyTally(), [
      credited(RUSHR_LAUNCH.curve, 3n * E18, B + 1n),
      credited(RUSHR_LAUNCH.hook, 1n * E18, B + 5n),
      credited('0x' + '77'.repeat(20), 2n * E18, B + 6n),
      credited(RUSHR_LAUNCH.curve, 9n * E18, B + 7n, '0x' + '11'.repeat(20)), // someone else's credit
      claimed(E18 / 2n, B + 8n),
      credited(RUSHR_LAUNCH.curve, 5n * E18, B + 200n), // past `to`
    ] as never, B + 100n);
    expect(t).toMatchObject({ cursor: (B + 100n).toString(), fromCurve: (3n * E18).toString(), fromHook: E18.toString(), fromOther: (2n * E18).toString() });
    expect(t.claims).toEqual([{ tx: expect.any(String), block: (B + 8n).toString(), at: '2027-01-15T08:00:00.000Z', raw: (E18 / 2n).toString() }]);
    // Replaying the same range adds nothing.
    expect(tallyEscrowLogs(t, [credited(RUSHR_LAUNCH.curve, 3n * E18, B + 1n)] as never, B + 100n).fromCurve).toBe((3n * E18).toString());
  });
});

describe('creatorTaxBody', () => {
  const tally = { ...emptyTally(), cursor: '115200000', fromCurve: (49n * E18 / 100n).toString(), fromHook: (2n * E18 / 100n).toString() };
  const live: CreatorTaxLive = {
    block: '115200000', at: '2026-11-16T00:00:00.000Z', escrowEth: (51n * E18 / 100n).toString(),
    pendingCreatorTax: { eth: (E18 / 10n).toString(), rushr: (2_000_000n * E18).toString() },
    pendingFees: { eth: (E18 / 20n).toString(), rushr: (1_000_000n * E18).toString() },
    protocolFeeShareBps: 3000,
  };
  it('earned = curve + pool credits + the creator share of what the hook holds; unclaimed = escrow balance + pending', () => {
    const b = creatorTaxBody(tally, live, { ethUsd: 2000, rushrUsd: 0.00002 });
    expect(b.earned.curve).toEqual({ raw: (49n * E18 / 100n).toString(), amount: '0.49', usd: 980 });
    expect(b.earned.pool.amount).toBe('0.02');
    // 0.1 + 0.05 × 70% ETH; 2M + 1M × 70% RUSHR
    expect(b.earned.pending).toMatchObject({ eth: { amount: '0.135', usd: 270 }, rushr: { amount: '2700000', usd: 54 }, usd: 324 });
    expect(b.earned.usd).toBe(980 + 40 + 324);
    expect(b.claimed).toEqual({ eth: { raw: '0', amount: '0', usd: 0 }, claims: [] });
    expect(b.unclaimed).toMatchObject({ escrow: { amount: '0.51', usd: 1020 }, usd: 1344 });
    expect(b.asOf).toEqual({ block: '115200000', at: '2026-11-16T00:00:00.000Z' });
  });
  it('without a live read: unclaimed escrow from the logs, pending null, USD null without prices', () => {
    const b = creatorTaxBody({ ...tally, claims: [{ tx: '0xab', block: '1', at: null, raw: (E18 / 100n).toString() }] }, null, { ethUsd: null, rushrUsd: null });
    expect(b.earned.pending).toBeNull();
    expect(b.unclaimed.escrow.amount).toBe('0.5');
    expect(b.claimed.claims[0]).toMatchObject({ amount: '0.01', explorer: 'https://robinhoodchain.blockscout.com/tx/0xab' });
    expect(b.earned.usd).toBeNull();
  });
});

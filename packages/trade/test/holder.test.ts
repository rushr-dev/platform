import { beforeEach, describe, expect, it } from 'vitest';
import { decodeAbiParameters, type Address, type PublicClient } from 'viem';
import { HOLDER_TIERS, RUSHR_TOKEN, resolveConfig } from '../src/config';
import { effectiveFeeBps } from '../src/referral';
import { clearHolderCache, holderDiscountBps, readHolderDiscountBps } from '../src/holder';
import { quotePool } from '../src/quote';
import { buildSwap } from '../src/build';
import { feeLine } from '../src/quick';
import { TRADE_ADDRESSES } from '../src/addresses';
import type { SwapRequest, V2Pool } from '../src/types';

const TREASURY: Address = '0x1111111111111111111111111111111111111111';
const TRADER: Address = '0x2222222222222222222222222222222222222222';
const REFERRER: Address = '0x5555555555555555555555555555555555555555';
const TOKEN: Address = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const M = 10n ** 24n; // 1M $RUSHR (18 decimals)
const beta = resolveConfig({ feeRecipient: TREASURY, feeBps: 25 }); // the beta rate, 0.25%

const v2Pool: V2Pool = { venue: 'uniswap-v2', id: '0x8018ee3ad3000000000000000000000000000000', token: TOKEN, quote: TRADE_ADDRESSES.weth, reserveToken: 10n ** 24n, reserveQuote: 10n ** 20n, venueFeeBps: 30, venueFeeLabel: 'v2' };
const req = (holderDiscountBps: number, referred = false): SwapRequest => ({
  side: 'buy', token: TOKEN, quoteAsset: 'ETH', amountIn: 10n ** 18n, trader: TRADER, slippageBps: 100,
  referral: referred ? { referrer: REFERRER } : null, holderDiscountBps,
});

/** A client whose only call is balanceOf on $RUSHR. */
const fakeClient = (balance: () => bigint) => {
  let calls = 0;
  const client = {
    readContract: async (a: { address: Address; functionName: string }) => {
      calls++;
      expect(a.address.toLowerCase()).toBe(RUSHR_TOKEN.toLowerCase());
      expect(a.functionName).toBe('balanceOf');
      return balance();
    },
  } as unknown as PublicClient;
  return { client, calls: () => calls };
};

describe('$RUSHR holder tiers', () => {
  it('1M = 10%, 10M = 25%, 50M = 50% off the fee; below 1M nothing', () => {
    expect(HOLDER_TIERS.map((t) => [t.min / M, t.discountBps])).toEqual([[50n, 5000], [10n, 2500], [1n, 1000]]);
    expect(holderDiscountBps(beta, 0n)).toBe(0);
    expect(holderDiscountBps(beta, M - 1n)).toBe(0);
    expect(holderDiscountBps(beta, M)).toBe(1000);
    expect(holderDiscountBps(beta, 10n * M - 1n)).toBe(1000);
    expect(holderDiscountBps(beta, 10n * M)).toBe(2500);
    expect(holderDiscountBps(beta, 50n * M)).toBe(5000);
    expect(holderDiscountBps(beta, 1_000n * M)).toBe(5000);
  });

  it('stacks with the referral discount, rounded in the trader\'s favour (whole bps)', () => {
    const ref = { referrer: REFERRER };
    // [holder bps, rate alone, rate when also referred], on the 0.25% beta fee
    const table: [number, number, number][] = [
      [0, 25, 22],
      [1000, 22, 20],
      [2500, 18, 16],
      [5000, 12, 10],
    ];
    for (const [h, alone, withRef] of table) {
      expect(effectiveFeeBps(beta, null, h)).toBe(alone);
      expect(effectiveFeeBps(beta, ref, h)).toBe(withRef);
    }
    // Never below zero, whatever the config.
    expect(effectiveFeeBps(beta, ref, 20_000)).toBe(0);
  });
});

describe('quotes with the holder discount', () => {
  it('charges the discounted rate and reports what each discount saved', async () => {
    const q = await quotePool({} as PublicClient, v2Pool, req(2500, true), beta);
    expect(q.fee).toMatchObject({ feeBps: 16, baseFeeBps: 25, holderDiscountBps: 2500, feeAmount: 16n * 10n ** 14n });
    // 25 -> 18 bps from holding, 18 -> 16 from the referral.
    expect(q.fee.holderDiscountAmount).toBe(7n * 10n ** 14n);
    expect(q.fee.referralDiscountAmount).toBe(2n * 10n ** 14n);
    // The built transaction sends exactly that fee to the treasury.
    const [, to, amount] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], buildSwap(q, beta).commands[0]!.input);
    expect([to, amount]).toEqual([TREASURY, 16n * 10n ** 14n]);
    expect(feeLine(q)).toBe('Rushr fee 0.16% (30% back as cashback, $RUSHR holder, 25% off, referral discount)');
  });

  it('without a tier the quote is unchanged', async () => {
    const q = await quotePool({} as PublicClient, v2Pool, req(0), beta);
    expect(q.fee).toMatchObject({ feeBps: 25, holderDiscountBps: 0, holderDiscountAmount: 0n, referralDiscountAmount: 0n });
    expect(feeLine(q)).toBe('Rushr fee 0.25% (30% back as cashback)');
  });
});

describe('reading the tier from the chain', () => {
  beforeEach(() => clearHolderCache());

  it('reads balanceOf once and caches it for a minute', async () => {
    const f = fakeClient(() => 12n * M);
    expect(await readHolderDiscountBps(f.client, TRADER, beta, 1_000)).toBe(2500);
    expect(await readHolderDiscountBps(f.client, TRADER, beta, 30_000)).toBe(2500);
    expect(f.calls()).toBe(1);
    expect(await readHolderDiscountBps(f.client, TRADER, beta, 70_000)).toBe(2500);
    expect(f.calls()).toBe(2);
  });

  it('a failed read gives no discount and is not cached', async () => {
    let fail = true;
    const f = fakeClient(() => {
      if (fail) throw new Error('rpc down');
      return 60n * M;
    });
    expect(await readHolderDiscountBps(f.client, TRADER, beta, 1_000)).toBe(0);
    fail = false;
    expect(await readHolderDiscountBps(f.client, TRADER, beta, 2_000)).toBe(5000);
  });

  it('no tiers configured: no read at all', async () => {
    const f = fakeClient(() => 60n * M);
    expect(await readHolderDiscountBps(f.client, TRADER, resolveConfig({ feeRecipient: TREASURY, holderTiers: [] }))).toBe(0);
    expect(f.calls()).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { computeSignals, measureTax, type TokenSnapshot } from '../src/signals/compute';
import { isContractCode } from '../src/chain/robinhood';

const E18 = 10n ** 18n;
const SUPPLY = 1_000_000_000n * E18;
const T0 = 1_800_000_000;

function base(over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  // 100 holders with 0.5% each = 50% held by the crowd; the rest sits in the pool.
  const holders = Array.from({ length: 100 }, (_, i) => ({ wallet: `w${i}`, amount: (SUPPLY * 5n) / 1000n }));
  return {
    address: 'tok', symbol: 'GOOD', totalSupply: SUPPLY, deployer: 'dev', createdAt: T0, createdBlock: 1000n,
    holders, holderCount: 100, earlyBuys: [], launchIndexed: true, wallets: { dev: { firstFunder: 'cex', firstSeen: T0 - 90 * 86400 } },
    airdropped: [], devTokens: [], twinOrganicHolders: 0, launchpad: 'pons', now: T0 + 3600, ...over,
  };
}

describe('computeSignals', () => {
  it('reports bundle and sniper as not measured when launch trades are missing', () => {
    const s = computeSignals(base({ launchIndexed: false }));
    expect(s.bundledPct).toBeNull();
    expect(s.snipersPct).toBeNull();
    expect(s.risk).toBe('low');
    expect(s.reasons.map((r) => r.text)).toContain('launch trades not indexed: bundle and sniper not measured');
  });

  it('rates an evenly held token from a fresh-start dev as low risk', () => {
    const s = computeSignals(base());
    expect(s.top10Pct).toBe(5);
    expect(s.risk).toBe('low');
    expect(s.verdict).toMatch(/^Low risk/);
  });

  it('flags a copycat clone with airdropped holders from a serial launcher as high risk', () => {
    const devTokens = Array.from({ length: 12 }, (_, i) => ({
      address: `clone${i}`, createdAt: T0 - i * 60, athMarketCapUsd: 28_000, marketCapUsd: 900, migrated: false,
    }));
    const s = computeSignals(
      base({
        symbol: 'ZOLVA',
        twinOrganicHolders: 1027,
        holderCount: 215,
        airdropped: Array.from({ length: 209 }, (_, i) => `a${i}`),
        devTokens,
      }),
    );
    expect(s.copycat).toBe(true);
    expect(s.spam).toBe(false); // launched through a launchpad, so not an airdrop-farm clone
    expect(s.dev.serialLauncher).toBe(true);
    expect(s.dev.rugs).toBe(12);
    expect(s.risk).toBe('high');
    expect(s.verdict).toContain('copycat: another $ZOLVA has 1027 real holders');
    expect(s.verdict).toContain('dev launched 12 tokens this week');
  });

  it('never flags the token with the real community as a copycat, even if a squatter launched first', () => {
    // Real PONS: 6,891 holders. An older squatter with the same ticker has 40 organic holders.
    const real = computeSignals(base({ symbol: 'PONS', holderCount: 6891, twinOrganicHolders: 40 }));
    expect(real.copycat).toBe(false);
    // The squatter, compared against the real one, is the copycat.
    const squatter = computeSignals(base({ symbol: 'PONS', holderCount: 40, twinOrganicHolders: 6891 }));
    expect(squatter.copycat).toBe(true);
  });

  it('does not count airdropped wallets as a real community', () => {
    // 300 holders but 290 of them airdropped: 10 organic vs a twin with 120 organic holders.
    const s = computeSignals(
      base({ symbol: 'CASHCAT', holderCount: 300, twinOrganicHolders: 120, airdropped: Array.from({ length: 290 }, (_, i) => `a${i}`) }),
    );
    expect(s.copycat).toBe(true);
    // Comparable communities: neither is called a copycat.
    expect(computeSignals(base({ symbol: 'AI', holderCount: 400, twinOrganicHolders: 500 })).copycat).toBe(false);
  });

  it('treats a few airdropped wallets on a big real token as noise, not spam', () => {
    // Real PONS: 1,036 holders, 182 of them received an airdrop (18%).
    const s = computeSignals(
      base({ symbol: 'PONS', launchpad: 'uniswap-v4', holderCount: 1036, airdropped: Array.from({ length: 182 }, (_, i) => `a${i}`) }),
    );
    expect(s.spam).toBe(false);
    expect(s.verdict).not.toContain('airdropped');
  });

  it('marks a plain-pool clone with a padded holder count as spam', () => {
    const airdropped = Array.from({ length: 206 }, (_, i) => `a${i}`);
    expect(computeSignals(base({ launchpad: 'uniswap-v4', airdropped })).spam).toBe(true);
    expect(computeSignals(base({ launchpad: 'uniswap-v4', airdropped: airdropped.slice(0, 5) })).spam).toBe(false);
    expect(computeSignals(base({ launchpad: 'pons', airdropped })).spam).toBe(false);
  });

  it('measures the launch bundle, snipers and insiders', () => {
    const big = (SUPPLY * 10n) / 100n; // 10% each
    const s = computeSignals(
      base({
        holders: [
          { wallet: 'b1', amount: big },
          { wallet: 'b2', amount: big },
          { wallet: 'ins', amount: big / 2n },
          { wallet: 'late', amount: SUPPLY / 100n },
        ],
        holderCount: 4,
        earlyBuys: [
          { trader: 'b1', block: 1000n, time: T0, tokenAmount: big },
          { trader: 'b2', block: 1001n, time: T0, tokenAmount: big },
          { trader: 'late', block: 1200n, time: T0 + 30, tokenAmount: SUPPLY / 100n },
        ],
        wallets: {
          dev: { firstFunder: 'mixer', firstSeen: T0 - 3600 },
          b1: { firstFunder: 'mixer', firstSeen: T0 - 600 },
          b2: { firstFunder: 'other', firstSeen: T0 - 600 },
          ins: { firstFunder: 'dev', firstSeen: T0 - 300 },
          late: { firstFunder: 'cex', firstSeen: T0 - 400 * 86400 },
        },
      }),
    );
    expect(s.bundledPct).toBe(20);
    expect(s.bundledStillHeldPct).toBe(20);
    expect(s.snipersPct).toBe(20);
    expect(s.sniperCount).toBe(2);
    expect(s.insidersPct).toBe(15); // b1 shares the dev's funder, ins was funded by the dev
    expect(s.freshWalletsPct).toBe(75);
    expect(s.risk).toBe('high');
    expect(s.reasons.map((r) => r.text)).toContain('20% still held by the launch bundle');
  });
});

describe('holder concentration counts people only', () => {
  it('tells contracts from EOAs and EIP-7702 delegated EOAs by code size', () => {
    expect(isContractCode('0x')).toBe(false);
    // 7702 delegation: 0xef0100 + 20-byte address = 23 bytes. Still a person.
    expect(isContractCode('0xef0100' + 'ab'.repeat(20))).toBe(false);
    // A locker/hook (MORPH's #1 holder has 1,969 bytes).
    expect(isContractCode('0x' + '60'.repeat(1969))).toBe(true);
    expect(isContractCode(null)).toBeNull();
  });

  it('reports burnt supply and computes top 10 over the people passed in', () => {
    // MORPH-shaped: the loader dropped the 8.16% locker, so the 11th wallet moves into the top 10.
    const pcts = [3.96, 3.89, 3.72, 3.05, 3.04, 2.95, 2.36, 2.34, 2.24, 2.15, 2.04];
    const holders = pcts.map((p, i) => ({ wallet: `p${i}`, amount: (SUPPLY * BigInt(Math.round(p * 100))) / 10_000n }));
    const s = computeSignals(base({ holders, holderCount: 266, burnt: SUPPLY / 20n }));
    expect(s.top10Pct).toBe(29.7);
    expect(s.burntPct).toBe(5);
  });
});

describe('contract tax (PONS creator tax)', () => {
  it('uses the contract tax over a measured 0 and reports the venue fee separately', () => {
    // MORPH: 3% creator tax + 1% PONS fee, both taken in ETH, so transfers measure 0.
    const zeroSamples = [
      { side: 'buy' as const, swapAmount: 100n * E18, traderNet: 100n * E18 },
      { side: 'buy' as const, swapAmount: 50n * E18, traderNet: 50n * E18 },
      { side: 'sell' as const, swapAmount: 100n * E18, traderNet: -100n * E18 },
      { side: 'sell' as const, swapAmount: 50n * E18, traderNet: -50n * E18 },
    ];
    const s = computeSignals(base({ taxSamples: zeroSamples, contractTax: { buyBps: 300, sellBps: 300, venueFeeBps: 100 } }));
    expect(s).toMatchObject({ buyTaxBps: 300, sellTaxBps: 300, taxSource: 'contract', venueFeeBps: 100 });
    expect(s.risk).toBe('low'); // 3% is under the 10% medium rule
    // Without a readable contract the measurement stands.
    expect(computeSignals(base({ taxSamples: zeroSamples }))).toMatchObject({ buyTaxBps: 0, sellTaxBps: 0, taxSource: 'measured', venueFeeBps: null });
    expect(computeSignals(base()).taxSource).toBeNull();
  });
});

describe('tax, no-sells and launch farms', () => {
  it('measures buy and sell tax from what reached the trader or the pool', () => {
    // 5% buy tax: the pool sent 100, the trader kept 95. 10% sell tax: the trader gave 100, the pool got 90.
    const samples = [
      { side: 'buy' as const, swapAmount: 100n * E18, traderNet: 95n * E18 },
      { side: 'buy' as const, swapAmount: 40n * E18, traderNet: 38n * E18 },
      { side: 'sell' as const, swapAmount: 90n * E18, traderNet: -100n * E18 },
      { side: 'sell' as const, swapAmount: 45n * E18, traderNet: -50n * E18 },
      // other transfers in the tx: ignored
      { side: 'buy' as const, swapAmount: 10n * E18, traderNet: 30n * E18 },
    ];
    expect(measureTax(samples)).toEqual({ buyTaxBps: 500, sellTaxBps: 1000 });
    // A normal token: wei-level rounding reads as 0; one sample isn't enough.
    expect(measureTax([
      { side: 'buy', swapAmount: 10n ** 21n, traderNet: 10n ** 21n - 3n },
      { side: 'buy', swapAmount: 10n ** 20n, traderNet: 10n ** 20n },
      { side: 'sell', swapAmount: 10n ** 20n, traderNet: -(10n ** 20n) },
    ])).toEqual({ buyTaxBps: 0, sellTaxBps: null });
  });

  it('flags a heavy sell tax and a token nobody has sold', () => {
    const taxed = computeSignals(base({
      taxSamples: [
        { side: 'sell', swapAmount: 40n * E18, traderNet: -100n * E18 },
        { side: 'sell', swapAmount: 4n * E18, traderNet: -10n * E18 },
      ],
    }));
    expect(taxed.sellTaxBps).toBe(6000);
    expect(taxed.risk).toBe('high');
    expect(taxed.reasons.map((r) => r.text)).toContain('sell tax 60%');
    const stuck = computeSignals(base({ tradeCounts: { buys: 40, sells: 0 } }));
    expect(stuck.noSells).toBe(true);
    expect(stuck.reasons.map((r) => r.text)).toContain('40 buys and no sells: may not be sellable');
    // Too early to tell.
    expect(computeSignals(base({ tradeCounts: { buys: 40, sells: 0 }, now: T0 + 120 })).noSells).toBe(false);
  });

  // Fixtures shaped on prod PONS tokens (2026-11-13): GIRAFF's original has 338 holders and squatters
  // launched before it; its copies have 1-5 holders.
  const holdersOf = (n: number) => Array.from({ length: n }, (_, i) => ({ wallet: `h${i}`, amount: SUPPLY / 1000n }));

  it('an original with only later copies is neither a farm nor a serial dev', () => {
    // Copies came after it, so the loader counts no earlier same-name deployers.
    const s = computeSignals(base({ symbol: 'AEON', holders: holdersOf(124), holderCount: 124, sameNameDeployers24h: 0, twinOrganicHolders: 2 }));
    expect(s.dev).toMatchObject({ serialLauncher: false, farm: false });
    expect(s.reasons.map((r) => r.text).join(' ')).not.toMatch(/farm|tokens this week/);
  });

  it('an original launched after squatters is not a farm when it leads its ticker by organic holders', () => {
    const s = computeSignals(base({ symbol: 'GIRAFF', holders: holdersOf(338), holderCount: 338, sameNameDeployers24h: 7, twinOrganicHolders: 5 }));
    expect(s.dev).toMatchObject({ serialLauncher: false, farm: false });
  });

  it('a copy of a farm is flagged farm (high risk) but not serial dev', () => {
    const s = computeSignals(base({ symbol: 'GIRAFF', holders: holdersOf(3), holderCount: 3, sameNameDeployers24h: 7, twinOrganicHolders: 338 }));
    expect(s.dev).toMatchObject({ serialLauncher: false, farm: true });
    expect(s.risk).toBe('high');
    expect(s.reasons.map((r) => r.text)).toContain('launch farm copy: 7 other wallets launched $GIRAFF in the 24h before it');
  });

  it('fresh farm copies tied at a holder or two still count as farm', () => {
    const s = computeSignals(base({ symbol: 'TURBO', holders: holdersOf(1), holderCount: 1, sameNameDeployers24h: 14, twinOrganicHolders: 1 }));
    expect(s.dev.farm).toBe(true);
  });

  it('a deployer with 158 launches this week is a serial dev (and not a farm by that alone)', () => {
    const devTokens = Array.from({ length: 158 }, (_, i) => ({ address: `t${i}`, createdAt: T0 - i * 3600, athMarketCapUsd: null, marketCapUsd: null, migrated: false }));
    const s = computeSignals(base({ devTokens }));
    expect(s.dev).toMatchObject({ serialLauncher: true, farm: false, launches7d: 158 });
    expect(s.reasons.map((r) => r.text)).toContain('dev launched 158 tokens this week');
  });
});

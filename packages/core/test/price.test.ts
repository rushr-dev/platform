import { describe, expect, it } from 'vitest';
import { acceptsPrice, PriceReference } from '../src/ingest/price';

// Real PONS swaps from production (2026-11-12), Ramses PONS/USDG 0xf2a0be59… and Uniswap v4 0x4be9657e….
const PONS = 0.1474; // reference price at the time
const usdg = (raw: bigint) => Number(raw) / 1e6;
const pons = (raw: bigint) => Number(raw) / 1e18;

describe('acceptsPrice', () => {
  it('rejects dust buys whose rounding implies a 400-6,000x price', () => {
    // tx 0xba88de1b…:50: 2467456159 wei PONS for 2 USDG units → $810/PONS
    const a = { usd: usdg(2n), price: usdg(2n) / pons(2467456159n), quoteRaw: 2n, reference: PONS };
    expect(a.price).toBeGreaterThan(800);
    expect(acceptsPrice(a)).toBe(false);
    // tx 0x926538ae…:21 (v4): 327148038 wei for 2 units → $6,113/PONS
    expect(acceptsPrice({ usd: usdg(2n), price: usdg(2n) / pons(327148038n), quoteRaw: 2n, reference: PONS })).toBe(false);
  });

  it('rejects dust sells that received nothing (price 0)', () => {
    expect(acceptsPrice({ usd: 0, price: 0, quoteRaw: 0n, reference: PONS })).toBe(false);
  });

  it('rejects dust even with no reference price yet', () => {
    expect(acceptsPrice({ usd: usdg(2n), price: 810, quoteRaw: 2n, reference: null })).toBe(false);
  });

  it('accepts normal trades, and big trades far from the reference (real pumps)', () => {
    expect(acceptsPrice({ usd: 152.3, price: 0.1481, quoteRaw: 152_300_000n, reference: PONS })).toBe(true);
    expect(acceptsPrice({ usd: 2_000, price: PONS * 5, quoteRaw: 2_000_000_000n, reference: PONS })).toBe(true);
  });

  it('rejects small trades more than 3x away from the reference, either way', () => {
    expect(acceptsPrice({ usd: 5, price: PONS * 4, quoteRaw: 5_000_000n, reference: PONS })).toBe(false);
    expect(acceptsPrice({ usd: 5, price: PONS / 4, quoteRaw: 5_000_000n, reference: PONS })).toBe(false);
    expect(acceptsPrice({ usd: 5, price: PONS * 2, quoteRaw: 5_000_000n, reference: PONS })).toBe(true);
  });
});

// Real IDLEX swaps from production (2026-11-18 02:49 UTC, block of tx 0x006a7ea7…). IDLEX traded at
// ~$0.000037 on its PONS curve (0x80b98a50…, 1B supply ≈ $37K cap); an arbitrage bot bought through
// thin Uniswap v4 side pools at 25-47x that, and the $62 leg (over TRUSTED_USD) drew a $1.6M wick.
describe('IDLEX side-pool arbitrage', () => {
  const SUPPLY = 1e9;
  const eth = (raw: bigint) => (Number(raw) / 1e18) * 1798.7; // ETH/USD as stored for this block
  const idlex = (raw: bigint) => Number(raw) / 1e18;
  const trade = (usd: number, tokens: bigint, quoteRaw: bigint, tx: string) => ({ usd, price: usd / idlex(tokens), quoteRaw, supply: SUPPLY, tx });
  // In chain order: curve buy, side-pool buys ($19, $62), curve buy ($326), side-pool buy ($27), curve buy.
  const block = [
    { pool: 'curve', t: trade(1.0377681114639201, 28998911611261397818764n, 577100000000000n, '0x076a7374') },
    { pool: '0xb9e5e0', t: trade(19.381636, 20605733584946647786037n, 19381636n, '0x006a7ea7') },
    { pool: '0x5abf0e', t: trade(62.390177, 38086447376454919352801n, 62390177n, '0x006a7ea7') },
    { pool: 'curve', t: trade(326.0291215206771, 8834212906454798090049139n, 181258499510578328n, '0x006a7ea7') },
    { pool: '0x4c8c5a', t: trade(eth(14981129519808783n), 15599283181681323840383n, 14981129519808783n, '0x006a7ea7') },
    { pool: 'curve', t: trade(1.0196910354035067, 26799145312372221603309n, 566905392314489n, '0xd60df874') },
  ];

  it('rejects the $62 side-pool buy at 44x the curve: it implies a pool of 0.004% of the cap', () => {
    const ref = block[0]!.t.price;
    const spike = block[2]!.t;
    expect(spike.price / ref).toBeGreaterThan(40);
    expect(spike.usd).toBeGreaterThan(50);
    expect(acceptsPrice({ ...spike, reference: ref })).toBe(false);
    // Without the supply the old rule applies (big trades move the price any distance).
    expect(acceptsPrice({ ...spike, supply: null, reference: ref })).toBe(true);
  });

  it('prices only the curve trades, so the 1m candle stays near $0.000037', () => {
    const r = new PriceReference();
    const priced = block.filter((b) => r.accept(b.t)).map((b) => b.pool);
    expect(priced).toEqual(['curve', 'curve', 'curve']);
    const high = Math.max(...block.filter((b) => b.pool === 'curve').map((b) => b.t.price));
    expect(high).toBeLessThan(0.00004);
  });

  it('still lets a big buy pump a real pool far past the reference', () => {
    // A fresh curve holding most of the supply: $3,000 into ~$1,000 of quote reserve fills at ~4x.
    expect(acceptsPrice({ usd: 3_000, price: 4e-6, quoteRaw: 1n, reference: 1e-6, supply: SUPPLY })).toBe(true);
    // And a big dump: $900 out of the same pool at a quarter of the price.
    expect(acceptsPrice({ usd: 900, price: 0.25e-6, quoteRaw: 1n, reference: 1e-6, supply: SUPPLY })).toBe(true);
  });
});

describe('PriceReference', () => {
  it('re-anchors after 3 agreeing outliers from 2+ transactions (a wrong reference cannot stick)', () => {
    const r = new PriceReference(1.0); // stale or poisoned reference; the market is at 0.02
    const t = (tx: string, price = 0.02) => ({ usd: 20, price, quoteRaw: 20_000_000n, supply: 1e6, tx });
    expect(r.accept(t('a'))).toBe(false);
    expect(r.accept(t('b', 0.021))).toBe(false);
    expect(r.accept(t('c', 0.019))).toBe(true);
    expect(r.price).toBe(0.019);
    expect(r.accept(t('d', 0.02))).toBe(true);
  });

  it('does not re-anchor on one transaction, or when a trade near the reference interrupts', () => {
    const r = new PriceReference(1.0);
    const t = (tx: string, price: number) => ({ usd: 20, price, quoteRaw: 20_000_000n, supply: 1e6, tx });
    for (let i = 0; i < 5; i++) expect(r.accept(t('arb', 40))).toBe(false);
    expect(r.accept(t('x', 40))).toBe(true); // a second transaction agrees: 6 outliers from 2 txs
    const q = new PriceReference(1.0);
    expect(q.accept(t('a', 40))).toBe(false);
    expect(q.accept(t('b', 40))).toBe(false);
    expect(q.accept(t('c', 1.1))).toBe(true); // back on the main pool: streak resets
    expect(q.accept(t('d', 40))).toBe(false);
    expect(q.price).toBe(1.1);
  });

  it('does not re-anchor on cents: agreeing outliers must add up to TRUSTED_USD', () => {
    // HOODCHAN 2026-11-15: $0.02-$1 sells in a side pool at 59x drew a wick when 3 of them agreed.
    const r = new PriceReference(0.00012);
    const t = (tx: string) => ({ usd: 0.5, price: 0.0071, quoteRaw: 1n, supply: 1e9, tx });
    for (const tx of ['a', 'b', 'c', 'd', 'e', 'f']) expect(r.accept(t(tx))).toBe(false);
    expect(r.price).toBe(0.00012);
  });

  it('ignores dust entirely', () => {
    const r = new PriceReference(1.0);
    expect(r.accept({ usd: 0.001, price: 50, quoteRaw: 1n, tx: 'a' })).toBe(false);
    expect(r.price).toBe(1.0);
  });
});

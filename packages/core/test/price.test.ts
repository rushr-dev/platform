import { describe, expect, it } from 'vitest';
import { acceptsPrice } from '../src/ingest/price';

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

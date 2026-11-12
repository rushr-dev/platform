import { describe, expect, it } from 'vitest';
import { applyTrade, emptyPosition } from '../src/pnl/position';

const T = 10n ** 18n;

describe('applyTrade (average cost)', () => {
  it('realizes proceeds minus the average cost of what was sold', () => {
    const p = emptyPosition();
    applyTrade(p, 'buy', 100n * T, 100); // 1.00 each
    applyTrade(p, 'buy', 100n * T, 300); // 3.00 each -> average 2.00
    expect(applyTrade(p, 'sell', 50n * T, 150)).toBeCloseTo(50); // 150 - 50 x 2.00
    expect(p).toMatchObject({ held: 150n * T, buys: 2, sells: 1, unbacked: 0n });
    expect(p.cost).toBeCloseTo(300);
    expect(applyTrade(p, 'sell', 150n * T, 150)).toBeCloseTo(-150); // closes at a loss
    expect(p.held).toBe(0n);
    expect(p.cost).toBe(0);
    expect(p.realized).toBeCloseTo(-100);
  });

  it('counts tokens sold beyond what was bought at zero cost (unbacked)', () => {
    const p = emptyPosition();
    applyTrade(p, 'buy', 10n * T, 10);
    expect(applyTrade(p, 'sell', 30n * T, 60)).toBeCloseTo(50); // 60 proceeds - 10 cost of the 10 backed
    expect(p).toMatchObject({ held: 0n, unbacked: 20n * T, sold: 30n * T });
  });

  it('a sell with nothing held is pure proceeds', () => {
    const p = emptyPosition();
    expect(applyTrade(p, 'sell', 5n * T, 7)).toBe(7);
    expect(p.unbacked).toBe(5n * T);
  });
});

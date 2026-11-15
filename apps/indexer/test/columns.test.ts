import { describe, expect, it } from 'vitest';
import { columnOf } from '../src/data';

describe('columnOf', () => {
  const card = (launchpad: string, bonding_progress: number) => ({ launchpad, bonding_progress, status: 'active' });

  it('puts a PONS curve past the threshold in Almost bonded', () => {
    expect(columnOf(card('pons', 0.5))).toBe('almost');
    expect(columnOf(card('pons', 0.1))).toBe('new');
  });

  it('keeps lift.fun out of Almost bonded while its progress sync is off', () => {
    // LIFTFUN_ENABLED off: the stored progress is frozen, so it doesn't decide the column.
    expect(columnOf(card('liftfun', 0.5))).toBe('new');
    expect(columnOf(card('liftfun', 0.5), true)).toBe('almost');
  });
});

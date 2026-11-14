import { describe, expect, it } from 'vitest';
import { liftUpdate } from '../src/liftfun';

// Shapes from api.lift.fun/api/v1/tokens (2026-11-13): DIG graduated, BRUH still bonding.
describe('lift.fun graduation and progress', () => {
  it('marks a graduated Robinhood token migrated at its graduation time, progress 1', () => {
    const u = liftUpdate({
      chain_id: 4663, address: '0x8FD48EDC40645A86AE73CE238F5CD840FD8E0087', graduated: true,
      graduated_at: '2026-10-16T08:45:53Z', progress_bps: 10000,
    });
    expect(u).toEqual({ token: '0x8fd48edc40645a86ae73ce238f5cd840fd8e0087', migratedAt: new Date('2026-10-16T08:45:53Z'), progress: 1 });
  });

  it('turns progress_bps into 0..1 and never reports 100% before graduation', () => {
    const base = { chain_id: 4663, address: '0x1111111111111111111111111111111111110087', graduated: false, graduated_at: null };
    expect(liftUpdate({ ...base, progress_bps: 1906 })?.progress).toBeCloseTo(0.1906);
    expect(liftUpdate({ ...base, progress_bps: 10000 })?.progress).toBe(0.999);
    expect(liftUpdate({ ...base, progress_bps: -5 })?.progress).toBe(0);
    expect(liftUpdate({ ...base, progress_bps: 1906 })?.migratedAt).toBeNull();
  });

  it('ignores other chains (Arc) and malformed items', () => {
    expect(liftUpdate({ chain_id: 5042, address: '0x71b27f7fa7e85d10aeb1dd4ef90b6f6971d90087', graduated: true, graduated_at: '2026-11-01T00:00:00Z', progress_bps: 10000 })).toBeNull();
    expect(liftUpdate({ chain_id: 4663, address: 'nope', graduated: false, graduated_at: null, progress_bps: 0 })).toBeNull();
  });

  it('keeps a graduated item without a usable time out of the migrated set', () => {
    expect(liftUpdate({ chain_id: 4663, address: '0x1111111111111111111111111111111111110087', graduated: true, graduated_at: 'garbage', progress_bps: 10000 })?.migratedAt).toBeNull();
  });
});

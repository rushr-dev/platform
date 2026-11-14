import { describe, expect, it } from 'vitest';
import { shouldRefresh, SIGNALS_STALE_MS } from '../src/signals-refresh';

describe('shouldRefresh', () => {
  const now = 1_800_000_000_000;
  it('refreshes stale or missing signals once, then debounces', () => {
    expect(shouldRefresh('0xa', new Date(now - 60_000), now)).toBe(false); // fresh
    expect(shouldRefresh('0xb', new Date(now - SIGNALS_STALE_MS - 1), now)).toBe(true);
    expect(shouldRefresh('0xb', new Date(now - SIGNALS_STALE_MS - 1), now + 30_000)).toBe(false); // debounced
    expect(shouldRefresh('0xb', new Date(now - SIGNALS_STALE_MS - 1), now + 3 * 60_000)).toBe(true);
    expect(shouldRefresh('0xc', null, now)).toBe(true); // never computed
  });
});

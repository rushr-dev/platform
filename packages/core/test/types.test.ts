import { describe, expect, it } from 'vitest';
import type { TokenStatus } from '../src';

describe('core', () => {
  it('exposes token statuses used by the terminal columns', () => {
    const columns: TokenStatus[] = ['new', 'bonding', 'migrated'];
    expect(columns).toHaveLength(3);
  });
});

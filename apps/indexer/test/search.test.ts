import { describe, expect, it } from 'vitest';
import { rankSearch, type SearchCandidate } from '../src/search';

const tok = (over: Partial<SearchCandidate>): SearchCandidate => ({
  address: '0x' + Math.random().toString(16).slice(2).padEnd(40, '0'), symbol: 'PLOG', name: 'PLOG', status: 'new', holders: 0,
  airdropped: 0, spam: false, copycat: false, liquidity_usd: null, volume_24h_usd: null, ...over,
});

describe('rankSearch', () => {
  // Shaped on prod PLOG (2026-11-14): the real one migrated from PONS with 214 holders; plain-pool copies
  // have 257 holders (206 of them airdropped) and bigger, fake market caps.
  const real = tok({ address: '0x534b76f46d69caee896c4f993a86ea2e12248b90', status: 'migrated', holders: 214, copycat: true });
  const farm = Array.from({ length: 19 }, () => tok({ holders: 257, airdropped: 206, spam: true, copycat: true, volume_24h_usd: 70_000 }));
  const bigPlain = tok({ holders: 687, volume_24h_usd: 1_000_000 });
  const prefix = tok({ symbol: 'PLOGGY', name: 'Ploggy', holders: 5000 });
  const byName = tok({ symbol: 'XYZ', name: 'The plog token', holders: 9000 });

  it('puts the migrated exact-symbol token first, even when the copycat rule flagged it', () => {
    const out = rankSearch([...farm, bigPlain, prefix, byName, real], 'plog');
    expect(out[0]).toBe(real);
    expect(out[1]).toBe(bigPlain);
    // Airdrop-farm copies sink below the clean token; prefix and name matches come after exact symbols.
    expect(out.slice(2, 21).every((t) => t.spam)).toBe(true);
    expect(out).toHaveLength(20);
  });

  it('orders by organic holders, not raw holders, when nothing migrated', () => {
    const padded = tok({ holders: 300, airdropped: 290 });
    const organic = tok({ holders: 120 });
    expect(rankSearch([padded, organic], 'PLOG')[0]).toBe(organic);
  });

  it('still finds an address, and symbol prefixes before name matches', () => {
    const exact = tok({ address: '0x6dbe95076584f869dd09a44131e9a3c13f34d7d6', symbol: 'MORPH', name: 'Morph' });
    expect(rankSearch([real, exact], '0x6dbe95076584f869dd09a44131e9a3c13f34d7d6')[0]).toBe(exact);
    expect(rankSearch([byName, prefix], 'plo').map((t) => t.symbol)).toEqual(['PLOGGY', 'XYZ']);
  });
});

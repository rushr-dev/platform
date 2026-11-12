import { describe, expect, it } from 'vitest';
import { zeroAddress } from 'viem';
import { fetchApiPools, hintsFromApiPools, parseApiPools, unroutableNote, type ApiPoolRow } from '../src/api-pools';
import { v4PoolId } from '../src/math';
import { TRADE_ADDRESSES } from '../src/addresses';

const PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const HOOK = '0x2c668601193e4a081dd82604785e436aff6a2acc'; // lift.fun hook
const hookedKey = { currency0: zeroAddress, currency1: PONS, fee: 8388608, tickSpacing: 200, hooks: HOOK } as const; // dynamic fee flag

const row = (r: Partial<ApiPoolRow>): ApiPoolRow => ({
  pool: '0x',
  dex: 'uniswap',
  version: 'v4',
  launchpad: null,
  quote: zeroAddress,
  token_is_currency0: false,
  key: null,
  liquidity_usd: null,
  volume_24h_usd: 0,
  trades_24h: 0,
  created_at: '2026-11-12T00:00:00Z',
  ...r,
});

/** Shape of GET /tokens/:a/pools on Data's branch (0c61362), checksummed addresses as the API may send them. */
const FIXTURE = {
  pools: [
    row({ pool: '0xe0c4ceb92d08ca985bb70fe0a22feb121a9854a8', dex: 'ramses', version: 'v3', quote: TRADE_ADDRESSES.weth, key: { currency0: TRADE_ADDRESSES.weth, currency1: PONS, fee: null, tickSpacing: 50, hooks: null }, volume_24h_usd: 3_100_000, liquidity_usd: 900_000 }),
    row({ pool: '0x6073975413484a350101c0c5d592a91ceb6c3ee881ad359613a08359fd1495a0', key: { currency0: zeroAddress, currency1: '0x39dBED3a2bd333467115dE45665cC57F813C4571', fee: 3000, tickSpacing: 60, hooks: zeroAddress }, volume_24h_usd: 2_000_000 }),
    row({ pool: v4PoolId(hookedKey), launchpad: 'liftfun', key: { ...hookedKey }, volume_24h_usd: 50_000 }),
    // Tampered: key does not hash to the pool id.
    row({ pool: `0x${'ab'.repeat(32)}`, key: { currency0: zeroAddress, currency1: PONS, fee: 100, tickSpacing: 1, hooks: zeroAddress }, volume_24h_usd: 1 }),
    row({ pool: '0x8018ee3ad3000000000000000000000000000000', dex: 'uniswap', version: 'v2', quote: TRADE_ADDRESSES.weth, key: { currency0: PONS, currency1: TRADE_ADDRESSES.weth, fee: null, tickSpacing: null, hooks: null }, volume_24h_usd: 20_000 }),
    row({ pool: '0x4be9657ec9000000000000000000000000000000000000000000000000000000', quote: TRADE_ADDRESSES.usdg, key: null }),
    row({ pool: '0xdb0f18faf3e0c9e26733ceeaefc3b8a188028050', dex: 'pons', version: 'curve', launchpad: 'pons', key: null }),
    { nonsense: true },
  ],
};

describe('Rushr API /tokens/:a/pools adapter', () => {
  it('parses the wrapped body and drops malformed rows', () => {
    expect(parseApiPools(FIXTURE)).toHaveLength(7);
    expect(parseApiPools(FIXTURE.pools)).toHaveLength(7);
    expect(parseApiPools({ error: 'not found' })).toEqual([]);
    expect(parseApiPools(null)).toEqual([]);
  });

  it('trusts only v4 keys that hash to their pool id, incl. hooked dynamic-fee pools', () => {
    const h = hintsFromApiPools(parseApiPools(FIXTURE), 'ETH');
    expect(h.v4Keys).toEqual([
      { currency0: zeroAddress, currency1: PONS, fee: 3000, tickSpacing: 60, hooks: zeroAddress },
      { ...hookedKey },
    ]);
    expect(h.rejected).toEqual([`0x${'ab'.repeat(32)}`]);
    expect(h.hasCurve).toBe(true);
  });

  it('filters by quote asset', () => {
    const usdg = hintsFromApiPools(parseApiPools(FIXTURE), 'USDG');
    expect(usdg.v4Keys).toEqual([]);
    expect(usdg.rejected).toEqual(['0x4be9657ec9000000000000000000000000000000000000000000000000000000']); // keyless v4 row
  });

  it('discloses busy pools on venues we cannot route yet (not Uniswap v2/v3)', () => {
    const h = hintsFromApiPools(parseApiPools(FIXTURE), 'ETH');
    expect(h.unroutable).toEqual([{ pool: '0xe0c4ceb92d08ca985bb70fe0a22feb121a9854a8', dex: 'ramses', version: 'v3', volume24hUsd: 3_100_000 }]);
    expect(unroutableNote(h)).toMatch(/ramses pools \(~\$3,100,000 24h volume\)/);
    expect(unroutableNote({ ...h, unroutable: [] })).toBeNull();
  });

  it('returns null (fallback) while the endpoint is not deployed, and never throws', async () => {
    const notFound = (async () => new Response('{"error":"not found"}', { status: 404 })) as typeof fetch;
    const broken = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    const ok = (async (url: string | URL | Request) => {
      expect(String(url)).toBe(`https://api.example/tokens/${PONS}/pools`);
      return new Response(JSON.stringify(FIXTURE), { status: 200 });
    }) as typeof fetch;
    expect(await fetchApiPools(PONS, { fetch: notFound })).toBeNull();
    expect(await fetchApiPools(PONS, { fetch: broken })).toBeNull();
    expect(await fetchApiPools('0x39dBED3a2bd333467115dE45665cC57F813C4571', { fetch: ok, apiUrl: 'https://api.example' })).toHaveLength(7);
  });
});

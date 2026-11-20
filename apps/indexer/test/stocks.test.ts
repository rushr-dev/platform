// GET /stocks (src/stocks.ts): Robinhood stock tokens by issuer + name, 24h change, sparklines, paired memecoins.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

import type { Sql } from 'postgres';
import { FEATURED_STOCK, STOCK_DEPLOYERS } from '@rushr/core';
import { freshDb, pgAvailable } from '../../../packages/agents/test/pg';
import { api } from '../src/api';
import { dropOutliers, shapeStocks, type StocksResponse } from '../src/stocks';

describe('dropOutliers / shapeStocks', () => {
  it('drops hourly points far from the median (bad prints), keeps real moves', () => {
    expect(dropOutliers([412, 96, 95, 96, 94, 92])).toEqual([96, 95, 96, 94, 92]);
    expect(dropOutliers([100, 95, 90, 85])).toEqual([100, 95, 90, 85]);
    expect(dropOutliers([5, 500])).toEqual([5, 500]);
  });
  it('computes the 24h change only against a real 24h-old price, and strips the name suffix', () => {
    const base = { address: '0x1', symbol: 'ANT', name: 'Anthropic, PBC Class A Common Stock • Robinhood Token', image_url: null, market_cap_usd: 1, volume_24h_usd: 1, liquidity_usd: null, holders: 1 };
    const [a, b] = shapeStocks([
      { ...base, price_usd: 90, open_24h: 100, spark: [100, 95, 90] },
      { ...base, price_usd: 90, open_24h: null, spark: null },
    ]);
    expect(a!.change_24h_pct).toBeCloseTo(-10);
    expect(a!.company).toBe('Anthropic, PBC Class A Common Stock');
    expect(b!.change_24h_pct).toBeNull();
    expect(b!.spark).toEqual([]);
  });
});

const ok = await pgAvailable();
describe.skipIf(!ok)('GET /stocks (local Postgres)', () => {
  let db: { url: string; sql: Sql; drop: () => Promise<void> };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} };
  const ISSUER = STOCK_DEPLOYERS[0]!;
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const SPY = '0x117cc2133c37b721f49de2a7a74833232b3b4c0c';
  const FAKE_SPY = '0xe8340a24eb85da7630558d211e1aaeee1d7f626b';
  const MEME = '0x88de4991146ecf15e4ca2cf44dce3b9f5c0f1e18';
  const FAKE_ANT = '0x03d8e6d35abd77f1b49acbbd3a3f93d08a5f1e18';
  const token = (address: string, o: Record<string, unknown>) => ({
    address, name: 'x', symbol: 'X', decimals: 18, total_supply: '1000', deployer: '0x' + '9'.repeat(40), created_block: 1,
    created_at: new Date('2026-06-23T00:00:00Z'), quote: USDG, holders: 50, price_usd: null, market_cap_usd: null, volume_24h_usd: null, ...o,
  });

  beforeAll(async () => {
    db = await freshDb('stocks');
    const sql = db.sql;
    await sql`insert into tokens ${sql([
      token(FEATURED_STOCK, { name: 'Anthropic, PBC Class A Common Stock • Robinhood Token', symbol: 'ANT', deployer: ISSUER, price_usd: 90, market_cap_usd: 2_400_000, volume_24h_usd: 37_000_000 }),
      token(SPY, { name: 'SPDR S&P 500 ETF Trust • Robinhood Token', symbol: 'SPY', deployer: ISSUER, price_usd: 700, market_cap_usd: 18_000_000, volume_24h_usd: 30_000_000 }),
      // Same name, another deployer: a copy, not the stock.
      token(FAKE_SPY, { name: 'SPDR S&P 500 ETF Trust • Robinhood Token', symbol: 'SPY', price_usd: 1, volume_24h_usd: 99_000_000 }),
      token(MEME, { name: 'Machine Inu', symbol: 'MI', quote: FEATURED_STOCK, market_cap_usd: 100_000, holders: 300 }),
      token(FAKE_ANT, { name: 'Anthropic', symbol: 'ANT', quote: FEATURED_STOCK, market_cap_usd: 200_000, holders: 21 }),
    ] as never)}`;
    await sql`insert into pools (id, token, quote, dex, created_block, created_at, liquidity_usd)
      values ('0x75ae79fd767a7cc410ab4eed13f8d3498e878d6a', ${FEATURED_STOCK}, ${USDG}, 'uniswap', 1, now(), 700000)`;
    // ANT: $100 a day ago (one $412 print at the mark doesn't move the median), $90 now.
    const c = (mAgo: number, close: number) => ({ token: FEATURED_STOCK, interval: '1m', bucket: new Date(Date.now() - mAgo * 60_000), open: close, high: close, low: close, close, volume_usd: 1, trades: 1 });
    await sql`insert into candles ${sql([c(24 * 60 + 30, 100), c(24 * 60 + 20, 412), c(24 * 60 + 10, 100), c(600, 95), c(5, 90)] as never)}`;
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('lists only the issuer\'s stocks, by 24h volume, with change, liquidity and sparkline', async () => {
    const res = await api.request('/stocks', {}, { DATABASE_URL: db.url, RPC_URL: 'http://rpc.invalid' }, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('s-maxage=30');
    const body = (await res.json()) as StocksResponse;
    expect(body.featured).toBe(FEATURED_STOCK);
    expect(body.stocks.map((s) => s.address)).toEqual([FEATURED_STOCK, SPY]);
    const ant = body.stocks[0]!;
    expect(ant.company).toBe('Anthropic, PBC Class A Common Stock');
    expect(ant.change_24h_pct).toBeCloseTo(-10);
    expect(ant.liquidity_usd).toBe(700000);
    expect(ant.spark).toEqual([95, 90]);
    // No history a day old: no change rather than a made-up one.
    expect(body.stocks[1]!.change_24h_pct).toBeNull();
  });

  it('lists memecoins priced in the featured stock, without look-alikes of the stock', async () => {
    const res = await api.request('/stocks', {}, { DATABASE_URL: db.url, RPC_URL: 'http://rpc.invalid' }, ctx);
    const body = (await res.json()) as StocksResponse;
    expect(body.paired.map((p) => p.symbol)).toEqual(['MI']);
  });
});

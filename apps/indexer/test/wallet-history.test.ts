// The profile's PnL chart and trade list (src/wallet-history.ts), against a throwaway local Postgres.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

import type { Sql } from 'postgres';
import { freshDb, pgAvailable } from '../../../packages/agents/test/pg';
import { thin, walletPnlHistory, walletTrades } from '../src/wallet-history';

const W = '0x' + '1'.repeat(40);
const OTHER = '0x' + '2'.repeat(40);
const TOKEN = '0x' + 'a'.repeat(40);
const E18 = 10n ** 18n;

describe('thin', () => {
  it('keeps short series as is and thins long ones evenly, keeping the last point', () => {
    expect(thin([1, 2, 3], 5)).toEqual([1, 2, 3]);
    const out = thin(Array.from({ length: 100 }, (_, i) => i), 10);
    expect(out).toHaveLength(10);
    expect(out[0]).toBe(0);
    expect(out.at(-1)).toBe(99);
  });
});

const ok = await pgAvailable();
describe.skipIf(!ok)('wallet history (local Postgres)', () => {
  let db: { url: string; sql: Sql; drop: () => Promise<void> };
  const now = Date.UTC(2026, 10, 17, 12);
  const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000);

  beforeAll(async () => {
    db = await freshDb('wallethistory');
    const sql = db.sql;
    await sql`insert into tokens (address, name, symbol, decimals, total_supply, deployer, created_block, created_at, price_usd)
      values (${TOKEN}, 'Purser', 'PURSER', 18, ${(1_000_000_000n * E18).toString()}, ${OTHER}, 1, now(), 0.00002)`;
    const swap = (li: number, hoursAgo: number, side: 'buy' | 'sell', usd: number, realized: number | null, trader = W) =>
      sql`insert into swaps (tx, log_index, token, pool, block, time, trader, side, token_amount, quote, quote_amount, usd, price_usd, realized_usd)
        values (${'0x' + li.toString(16).padStart(64, '0')}, 0, ${TOKEN}, '0xpool', ${li}, ${at(hoursAgo)}, ${trader}, ${side},
          ${(1000n * E18).toString()}, '0x0', '1', ${usd}, 0.00001, ${realized})`;
    await swap(1, 24 * 10, 'buy', 100, null); // 10 days ago
    await swap(2, 24 * 9, 'sell', 150, 50); // +50, 9 days ago
    await swap(3, 30, 'buy', 80, null);
    await swap(4, 5, 'sell', 60, -20); // -20, today
    await swap(5, 2, 'sell', 40, 10); // +10, today
    await swap(6, 1, 'sell', 999, 500, OTHER); // someone else's
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('sums realized PnL per sell from $0 at the range start', async () => {
    const day = await walletPnlHistory(db.sql, W, '24h', now);
    expect(day.points.map((p) => p.pnl)).toEqual([-20, -10]);
    expect(day).toMatchObject({ realizedUsd: -10, sells: 2, from: Math.floor((now - 86_400_000) / 1000) });
    const all = await walletPnlHistory(db.sql, W, 'all', now);
    expect(all.points.map((p) => p.pnl)).toEqual([50, 30, 40]);
    expect(all.realizedUsd).toBe(40);
  });

  it('lists trades newest first with market cap, realized PnL on sells, and pages back', async () => {
    const first = await walletTrades(db.sql, W, { limit: 2 });
    expect(first.trades.map((t) => [t.side, t.usd, t.realizedUsd])).toEqual([['sell', 40, 10], ['sell', 60, -20]]);
    expect(first.trades[0]).toMatchObject({ symbol: 'PURSER', mcapUsd: 10_000 });
    expect(first.nextBefore).not.toBeNull();
    const next = await walletTrades(db.sql, W, { limit: 10, before: first.nextBefore });
    expect(next.trades.map((t) => t.side)).toEqual(['buy', 'sell', 'buy']);
    expect(next.trades[0]!.realizedUsd).toBeNull();
    expect(next.nextBefore).toBeNull();
  });
});

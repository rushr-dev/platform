// Re-pricing stored swaps with the current outlier guard (src/reprice.ts), on the IDLEX side-pool wick.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { freshDb, pgAvailable } from '../../../packages/agents/test/pg';
import { outlierTokens, repriceToken } from '../src/reprice';

const TOKEN = '0x' + 'aa'.repeat(20);
const DEV = '0x' + '11'.repeat(20);
const E18 = 10n ** 18n;
const T0 = Date.parse('2026-11-18T02:48:00Z') / 1000;

const ok = await pgAvailable();
describe.skipIf(!ok)('repriceToken (local Postgres)', () => {
  let db: { url: string; sql: Sql; drop: () => Promise<void> };
  beforeAll(async () => {
    db = await freshDb('reprice');
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await db.sql`truncate tokens, swaps, candles`;
    // 1B supply at ~$0.000037; the stored ATH and the 02:49 candle carry the $0.00164 side-pool wick.
    await db.sql`insert into tokens (address, name, symbol, decimals, total_supply, deployer, created_block, created_at, price_usd, market_cap_usd, ath_market_cap_usd, price_at)
      values (${TOKEN}, 'Idlex', 'IDLEX', 18, ${(1_000_000_000n * E18).toString()}, ${DEV}, 1, now(), 0.0000369, 36900, 1638120, to_timestamp(${T0 + 70}))`;
    const swap = (li: number, tx: string, t: number, pool: string, tokens: number, usd: number, price: number | null) =>
      db.sql`insert into swaps (tx, log_index, token, pool, block, time, trader, side, token_amount, quote, quote_amount, price_usd, usd)
        values (${tx}, ${li}, ${TOKEN}, ${pool}, ${100 + li}, to_timestamp(${t}), ${DEV}, 'buy', ${(BigInt(Math.round(tokens)) * E18).toString()},
          '0x0000000000000000000000000000000000000000', ${String(BigInt(Math.round(usd * 1e6)) * 10n ** 12n)}, ${price}, ${usd})`;
    await swap(1, '0x01', T0 + 10, 'curve', 28_000, 1.0, 1.0 / 28_000);
    await swap(2, '0x02', T0 + 71, 'side', 38_086, 62.39, 62.39 / 38_086); // the wick, priced by the old rule
    await swap(3, '0x02', T0 + 71, 'curve', 8_834_213, 326, 326 / 8_834_213);
    await db.sql`insert into candles (token, interval, bucket, open, high, low, close, volume_usd, trades) values
      (${TOKEN}, '1m', to_timestamp(${T0}), ${1 / 28_000}, ${1 / 28_000}, ${1 / 28_000}, ${1 / 28_000}, 1, 1),
      (${TOKEN}, '1m', to_timestamp(${T0 + 60}), ${62.39 / 38_086}, ${62.39 / 38_086}, ${326 / 8_834_213}, ${326 / 8_834_213}, 388.39, 2)`;
  });

  it('the scan finds the token', async () => {
    expect((await outlierTokens(db.sql, 3650, 10)).map((t) => t.token)).toEqual([TOKEN]);
  });

  it('dry run reports the fix and writes nothing', async () => {
    const r = await repriceToken(db.sql, TOKEN, { write: false });
    expect(r).toMatchObject({ swaps: 3, unpriced: 1, priced: 0, candlesChanged: 1, candlesRemoved: 0 });
    expect(r!.highAfter).toBeCloseTo(326 / 8_834_213, 12);
    const [c] = await db.sql<{ high: number }[]>`select high::float8 as high from candles where bucket = to_timestamp(${T0 + 60})`;
    expect(c!.high).toBeCloseTo(62.39 / 38_086, 9);
  });

  it('write unprices the side-pool swap, rebuilds the candle and lowers the ATH', async () => {
    await repriceToken(db.sql, TOKEN, { write: true });
    const [s] = await db.sql<{ price_usd: string | null }[]>`select price_usd::text from swaps where log_index = 2`;
    expect(s!.price_usd).toBeNull();
    const [c] = await db.sql<{ high: number; volume: number; trades: number }[]>`
      select high::float8 as high, volume_usd::float8 as volume, trades from candles where bucket = to_timestamp(${T0 + 60})`;
    expect(c).toMatchObject({ trades: 1 });
    expect(c!.high).toBeCloseTo(326 / 8_834_213, 12);
    expect(c!.volume).toBeCloseTo(326, 6);
    const [t] = await db.sql<{ ath: number }[]>`select ath_market_cap_usd::float8 as ath from tokens`;
    expect(t!.ath).toBeCloseTo((326 / 8_834_213) * 1e9, 3);
    // Idempotent: a second run changes nothing.
    expect(await repriceToken(db.sql, TOKEN, { write: true })).toMatchObject({ unpriced: 0, priced: 0, candlesChanged: 0, candlesRemoved: 0 });
  });
});

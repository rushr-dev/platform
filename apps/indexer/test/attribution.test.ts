// Router-credited swaps re-credited to the wallet that traded (src/attribution.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { freshDb, pgAvailable } from '../../../packages/agents/test/pg';
import { reattributeSwaps, repairTraders } from '../src/attribution';

const ROUTER = '0x204faca1764b154221e35c0d20abb3c525710498';
const PM = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const TOKEN = '0x' + 'aa'.repeat(20);
const ALICE = '0x' + '11'.repeat(20);
const BOB = '0x' + '22'.repeat(20);
const PAIR = '0x' + '33'.repeat(20);

const ok = await pgAvailable();
describe.skipIf(!ok)('re-crediting router swaps (local Postgres)', () => {
  let db: { url: string; sql: Sql; drop: () => Promise<void> };
  beforeAll(async () => {
    db = await freshDb('attribution');
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await db.sql`truncate swaps, transfers, pools`;
  });
  const swap = (tx: string, li: number, side: 'buy' | 'sell', trader: string, block = 100) =>
    db.sql`insert into swaps (tx, log_index, token, pool, block, time, trader, side, token_amount, quote, quote_amount, usd)
      values (${tx}, ${li}, ${TOKEN}, '0xpool', ${block}, now(), ${trader}, ${side}, '1000', '0x0', '1', 30)`;
  const transfer = (tx: string, li: number, from: string, to: string) =>
    db.sql`insert into transfers (tx, log_index, token, block, time, "from", "to", amount) values (${tx}, ${li}, ${TOKEN}, 100, now(), ${from}, ${to}, '1000')`;
  const trader = async (tx: string) => (await db.sql<{ trader: string }[]>`select trader from swaps where tx = ${tx}`)[0]!.trader;

  it('repairTraders re-credits only rows stored with an infra trader', async () => {
    await swap('0x01', 1, 'buy', ROUTER);
    await swap('0x02', 1, 'buy', BOB);
    const pairs = await repairTraders(db.sql, [
      { tx: '0x01', logIndex: 1, token: TOKEN, trader: ALICE },
      { tx: '0x02', logIndex: 1, token: TOKEN, trader: ALICE }, // already a wallet: left alone
      { tx: '0x01', logIndex: 1, token: TOKEN, trader: ROUTER }, // unresolved in this batch too: ignored
    ]);
    expect(pairs).toEqual([{ wallet: ALICE, token: TOKEN }]);
    expect(await trader('0x01')).toBe(ALICE);
    expect(await trader('0x02')).toBe(BOB);
  });

  it('reattributeSwaps: buys to the last receiver, sells to the first sender, skipping infra and pools; dry run writes nothing', async () => {
    await db.sql`insert into pools (id, token, quote, token_is_currency0, dex, created_block, created_at) values (${PAIR}, ${TOKEN}, '0x0', true, 'v2', 1, now())`;
    await swap('0x0a', 5, 'buy', ROUTER, 200);
    await transfer('0x0a', 2, PM, ROUTER);
    await transfer('0x0a', 3, ROUTER, ALICE);
    await swap('0x0b', 5, 'sell', ROUTER, 150);
    await transfer('0x0b', 1, BOB, ROUTER);
    await transfer('0x0b', 2, ROUTER, PAIR);
    await swap('0x0c', 5, 'buy', ROUTER, 120); // no transfers indexed: left as it is

    const dry = await reattributeSwaps(db.sql, { limit: 10 });
    expect(dry).toMatchObject({ checked: 3, resolved: 2, updated: 0, next: null });
    expect(await trader('0x0a')).toBe(ROUTER);

    const page = await reattributeSwaps(db.sql, { limit: 1, write: true });
    expect(page).toMatchObject({ checked: 1, updated: 1, next: { block: '200', logIndex: 5 }, pairs: [{ wallet: ALICE, token: TOKEN }] });
    const rest = await reattributeSwaps(db.sql, { limit: 10, before: page.next, write: true });
    expect(rest).toMatchObject({ checked: 2, resolved: 1, updated: 1, next: null });
    expect([await trader('0x0a'), await trader('0x0b'), await trader('0x0c')]).toEqual([ALICE, BOB, ROUTER]);
  });
});

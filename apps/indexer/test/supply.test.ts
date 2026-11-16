// Live total supply, market caps on total supply, circulating supply (src/supply.ts), and the pipeline path that feeds them.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { circulatingSupply } from '@rushr/core';
import { freshDb, pgAvailable } from '../../../packages/agents/test/pg';
import { DEAD_WALLETS, capSupplySql, circulatingSql, refreshSupply, repriceCaps, supplyDeltas, supplyTouched } from '../src/supply';
import { Pipeline } from '../src/pipeline';

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
const TOKEN = '0x' + 'aa'.repeat(20);
const ALICE = '0x' + '11'.repeat(20);
const E18 = 10n ** 18n;

describe('supplyDeltas / supplyTouched', () => {
  const t = (from: string, to: string, amount: bigint, block = 10n) => ({ token: TOKEN, from, to, amount, block });
  it('counts mints up and burns to 0x0 down; moves between people are not supply changes', () => {
    expect(supplyDeltas([t(ZERO, ALICE, 5n), t(ALICE, ZERO, 2n), t(ALICE, DEAD, 1n), t(ALICE, ALICE, 9n)])).toEqual([
      { token: TOKEN, block: '10', delta: '5' },
      { token: TOKEN, block: '10', delta: '-2' },
    ]);
  });
  it('marks tokens whose circulating supply moved (0x0 or a dead address on either side)', () => {
    expect(supplyTouched([t(ALICE, DEAD, 1n)])).toEqual([TOKEN]);
    expect(supplyTouched([t(ALICE, '0x' + '22'.repeat(20), 1n)])).toEqual([]);
  });
  it('excludes 0x0 from the dead wallets (balances never hold it)', () => {
    expect(DEAD_WALLETS).toContain(DEAD);
    expect(DEAD_WALLETS).not.toContain(ZERO);
  });
});

describe('circulatingSupply', () => {
  it('is totalSupply minus burn-address balances, never negative', () => {
    expect(circulatingSupply({ totalSupply: 100n, burnt: 10n })).toBe(90n);
    expect(circulatingSupply({ totalSupply: 100n })).toBe(100n);
    expect(circulatingSupply({ totalSupply: 5n, burnt: 10n })).toBe(0n);
  });
});

const ok = await pgAvailable();
describe.skipIf(!ok)('supply tracking (local Postgres)', () => {
  let db: { url: string; sql: Sql; drop: () => Promise<void> };
  beforeAll(async () => {
    db = await freshDb('supply');
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(async () => {
    await db.sql`truncate tokens, balances, transfers`;
  });

  async function token(supply: bigint, supplyBlock: bigint | null, price: number | null = null) {
    await db.sql`insert into tokens (address, name, symbol, decimals, total_supply, supply_block, deployer, created_block, created_at, price_usd)
      values (${TOKEN}, 'Purser', 'PURSER', 18, ${supply.toString()}, ${supplyBlock?.toString() ?? null}, ${ALICE}, 1, now(), ${price})`;
  }
  const row = async () =>
    (await db.sql<{ total_supply: string; supply_block: string | null; market_cap_usd: string | null }[]>`
      select total_supply::text, supply_block::text, market_cap_usd::text from tokens where address = ${TOKEN}`)[0]!;

  /** Raw Transfer logs, as rpc.transferLogs returns them. */
  const log = (from: string, to: string, amount: bigint, block: number, i: number) => ({
    address: TOKEN, transactionHash: '0x' + i.toString(16).padStart(64, '0'), logIndex: '0x0', blockNumber: '0x' + block.toString(16),
    blockTimestamp: '0x' + (1_800_000_000 + block).toString(16),
    topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + from.slice(2).padStart(64, '0'), '0x' + to.slice(2).padStart(64, '0')],
    data: '0x' + amount.toString(16).padStart(64, '0'),
  });
  const pipelineWith = (logs: ReturnType<typeof log>[]) =>
    new Pipeline(db.sql, { transferLogs: async () => logs, tokenMetadata: async () => [] } as never, { historical: true });

  it('subtracts burns and adds mints after supply_block, ignores ones already in the reading', async () => {
    await token(1_000n * E18, 100n, 2);
    await pipelineWith([
      log(ZERO, ALICE, 1_000n * E18, 50, 1), // the launch mint: before the reading
      log(ALICE, ZERO, 30n * E18, 90, 2), // burnt before the reading: already in it
      log(ALICE, ZERO, 64n * E18, 150, 3), // burn() after it
      log(ALICE, DEAD, 10n * E18, 160, 4), // sent to 0xdead: still in totalSupply, so still in market cap
      log(ZERO, ALICE, 4n * E18, 170, 5), // a later mint
    ]).backfillTransfers(TOKEN as never, 0n, 200n);
    const r = await row();
    expect(r.total_supply).toBe((940n * E18).toString());
    // 940 × $2: market cap is on total supply (as GMGN), the 0xdead balance included
    expect(Number(r.market_cap_usd)).toBeCloseTo(1_880, 6);
  });

  it('leaves rows read at an unknown block alone (supply_block null)', async () => {
    await token(1_000n * E18, null);
    await pipelineWith([log(ALICE, ZERO, 64n * E18, 150, 6)]).backfillTransfers(TOKEN as never, 0n, 200n);
    expect((await row()).total_supply).toBe((1_000n * E18).toString());
  });

  it('a replayed transfer is applied once', async () => {
    await token(1_000n * E18, 100n);
    const logs = [log(ALICE, ZERO, 5n * E18, 150, 7)];
    await pipelineWith(logs).backfillTransfers(TOKEN as never, 0n, 200n);
    await pipelineWith(logs).backfillTransfers(TOKEN as never, 0n, 200n);
    expect((await row()).total_supply).toBe((995n * E18).toString());
  });

  it('circulatingSql drops dead balances; capSupplySql and repriceCaps use totalSupply', async () => {
    await token(935_361_757n * E18, 100n, 0.0000382);
    await db.sql`insert into balances (token, wallet, amount, first_received_at) values (${TOKEN}, ${DEAD}, ${(10_000_000n * E18).toString()}, now())`;
    const [c] = await db.sql<{ supply: string }[]>`${circulatingSql(db.sql, TOKEN)}`;
    expect(Number(c!.supply)).toBe(925_361_757);
    const [cap] = await db.sql<{ supply: string }[]>`${capSupplySql(db.sql, TOKEN)}`;
    expect(Number(cap!.supply)).toBe(935_361_757);
    await repriceCaps(db.sql, [TOKEN]);
    expect(Number((await row()).market_cap_usd)).toBeCloseTo(935_361_757 * 0.0000382, 4);
  });

  it('refreshSupply stores the reading with its block, adds back burns indexed past it, and reprices', async () => {
    await token(1_000_000_000n * E18, null, 0.0000382);
    // Indexed while the reading was in flight: a burn after the read block.
    await db.sql`insert into transfers (tx, log_index, token, block, time, "from", "to", amount)
      values ('0x01', 0, ${TOKEN}, 210, now(), ${ALICE}, ${ZERO}, ${(1_000_000n * E18).toString()}),
             ('0x02', 0, ${TOKEN}, 190, now(), ${ALICE}, ${ZERO}, ${(9n * E18).toString()})`;
    const rpc = { totalSupplies: async () => [{ token: TOKEN, totalSupply: 935_361_757n * E18, supplyBlock: 200n }] };

    const dry = await refreshSupply(db.sql, rpc as never, [TOKEN], { dryRun: true });
    expect(dry[0]).toMatchObject({ before: (1_000_000_000n * E18).toString(), after: (935_361_757n * E18).toString() });
    expect((await row()).supply_block).toBeNull();

    await refreshSupply(db.sql, rpc as never, [TOKEN]);
    const r = await row();
    expect(r.supply_block).toBe('200');
    expect(r.total_supply).toBe((934_361_757n * E18).toString());
    expect(Number(r.market_cap_usd)).toBeCloseTo(934_361_757 * 0.0000382, 4);
  });

  it('refreshSupply skips failed reads', async () => {
    await token(1_000n * E18, null);
    const rpc = { totalSupplies: async () => [{ token: TOKEN, totalSupply: null, supplyBlock: 200n }] };
    expect(await refreshSupply(db.sql, rpc as never, [TOKEN])).toEqual([]);
    expect((await row()).supply_block).toBeNull();
  });
});

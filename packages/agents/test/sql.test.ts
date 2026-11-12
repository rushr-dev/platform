import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { freshDb, pgAvailable } from './pg';
import { leaderboardInputs } from '../src/sql';
import { rank } from '../src/leaderboard';

const pg = await pgAvailable();
const T0 = new Date('2026-11-12T00:00:00Z');
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const E18 = 10n ** 18n;

describe.skipIf(!pg)('leaderboardInputs (local Postgres)', () => {
  let sql: Sql;
  let drop: () => Promise<void>;
  let n = 0;
  const token = async (address: string, deployer: string, price: number) => {
    await sql`insert into tokens (address, name, symbol, decimals, total_supply, deployer, created_block, created_at, price_usd, liquidity_usd)
      values (${address}, ${address}, ${address}, 18, ${(1_000_000n * E18).toString()}, ${deployer}, 1, ${T0}, ${price}, 1000000)`;
  };
  const swap = async (o: { tok: string; trader: string; side: 'buy' | 'sell'; tokens: number; usd: number; min: number; tx?: string; block?: number; pool?: string }) => {
    n++;
    await sql`insert into swaps (tx, log_index, token, pool, block, time, trader, side, token_amount, quote, quote_amount, usd)
      values (${o.tx ?? `0xtx${n}`}, ${n}, ${o.tok}, ${o.pool ?? 'pool_' + o.tok}, ${o.block ?? 1000 + n}, ${at(o.min)}, ${o.trader}, ${o.side},
        ${(BigInt(o.tokens) * E18).toString()}, '0x0', '0', ${o.usd})`;
  };
  /** 20 outside traders so the token passes the distinct-traders rule. */
  const crowd = async (tok: string) => {
    for (let i = 0; i < 20; i++) await swap({ tok, trader: `0xcrowd${i}`, side: 'buy', tokens: 1, usd: 10, min: 1 });
  };

  beforeAll(async () => {
    ({ sql, drop } = await freshDb('lb'));
    await sql`insert into members (id, kind, handle, wallet, privy_did) values ('alice', 'human', 'alice', '0xalice', 'did:1'), ('dev', 'human', 'dev', '0xdev', 'did:2')`;
    await sql`insert into members (id, kind, origin, handle, wallet, owner_id, owner_changed_at) values ('bot', 'agent', 'external', 'bot', '0xbot', 'alice', ${at(30)})`;
    await sql`insert into wallets (address, first_funder) values ('0xbot', '0xalice')`;
    for (const t of ['tok_a', 'tok_b', 'tok_c']) {
      await token(t, '0xsomeone', 2);
      await crowd(t);
    }
    await token('tok_dev', '0xdev', 2);
    await crowd('tok_dev');
    await token('tok_thin', '0xsomeone', 2); // only 1 trader: excluded

    // alice: +$100 realized on tok_a, a held position on tok_b.
    await swap({ tok: 'tok_a', trader: '0xalice', side: 'buy', tokens: 100, usd: 100, min: 10 });
    await swap({ tok: 'tok_a', trader: '0xalice', side: 'sell', tokens: 100, usd: 200, min: 20 });
    await swap({ tok: 'tok_b', trader: '0xalice', side: 'buy', tokens: 50, usd: 50, min: 10 });
    // excluded: dust trade, atomic round trip, thin token.
    await swap({ tok: 'tok_c', trader: '0xalice', side: 'buy', tokens: 1, usd: 2, min: 10 });
    await swap({ tok: 'tok_c', trader: '0xalice', side: 'buy', tokens: 10, usd: 10, min: 11, tx: '0xrt' });
    await swap({ tok: 'tok_c', trader: '0xalice', side: 'sell', tokens: 10, usd: 30, min: 11, tx: '0xrt' });
    await swap({ tok: 'tok_thin', trader: '0xalice', side: 'buy', tokens: 10, usd: 10, min: 12 });
    // dev trading their own launch: excluded.
    await swap({ tok: 'tok_dev', trader: '0xdev', side: 'buy', tokens: 10, usd: 10, min: 10 });
    // wash between alice and her agent in the same block and pool: excluded for both.
    await swap({ tok: 'tok_c', trader: '0xalice', side: 'sell', tokens: 5, usd: 50, min: 40, block: 9999, pool: 'pool_c' });
    await swap({ tok: 'tok_c', trader: '0xbot', side: 'buy', tokens: 5, usd: 50, min: 40, block: 9999, pool: 'pool_c' });
    // bot: one trade before it was linked (min 5), one after (min 35).
    await swap({ tok: 'tok_b', trader: '0xbot', side: 'buy', tokens: 10, usd: 10, min: 5 });
    await swap({ tok: 'tok_b', trader: '0xbot', side: 'buy', tokens: 10, usd: 10, min: 35 });
  });
  afterAll(async () => drop?.());

  it('aggregates eligible swaps per member and token, with the exclusions applied', async () => {
    const { members, aggs } = await leaderboardInputs(sql, { from: T0, to: at(120) });
    expect(members.map((m) => m.id).sort()).toEqual(['alice', 'bot', 'dev']);
    expect(members.find((m) => m.id === 'bot')!.firstFunder).toBe('0xalice');
    const key = (a: { memberId: string; token: string }) => `${a.memberId}:${a.token}`;
    expect(aggs.map(key).sort()).toEqual(['alice:tok_a', 'alice:tok_b', 'bot:tok_b']);
    const a = aggs.find((x) => key(x) === 'alice:tok_a')!;
    expect(a).toMatchObject({ boughtTokens: 100, boughtUsd: 100, soldTokens: 100, soldUsd: 200, trades: 2 });
    const bot = aggs.find((x) => key(x) === 'bot:tok_b')!;
    expect(bot.boughtTokens).toBe(20);
    expect(bot.linked).toMatchObject({ boughtTokens: 10, trades: 1 });
  });

  it('feeds the ranking', async () => {
    const { members, aggs } = await leaderboardInputs(sql, { from: T0, to: at(120) });
    const lb = rank(members, aggs, 'all', { minTrades: 1, minTokens: 1, teamCap: 3, minLiquidityForGainsUsd: 10_000, maxGainShareOfLiquidity: 0.25 });
    const alice = lb.rows.find((r) => r.member.id === 'alice')!;
    // tok_a +100 realized, tok_b 50 tokens at $2 = +50 unrealized; bot linked: 10 tokens bought for $10, worth $20 = +10.
    expect(alice.pnl).toBeCloseTo(150);
    expect(alice.score).toBeCloseTo(160);
    expect(alice.inclAgents).toBe(true);
  });
});

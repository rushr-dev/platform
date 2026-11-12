import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgAvailable, setup } from './harness';

const pg = await pgAvailable();
const w = (n: number) => `0x${String(n).padStart(40, '0')}`;
const E18 = 10n ** 18n;

describe.skipIf(!pg)('leaderboard (Season 0)', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  let n = 0;
  const swap = async (tok: string, trader: string, side: 'buy' | 'sell', tokens: number, usd: number, minsAgo: number) => {
    n++;
    await t.sql`insert into swaps (tx, log_index, token, pool, block, time, trader, side, token_amount, quote, quote_amount, usd)
      values (${'0xt' + n}, ${n}, ${tok}, ${'pool_' + tok}, ${n}, now() - make_interval(mins => ${minsAgo}), ${trader}, ${side}, ${(BigInt(tokens) * E18).toString()}, '0x0', '0', ${usd})`;
  };
  /** Three tokens, two round trips each: realized pnl = 3 * (sell - buy). */
  const trade3 = async (trader: string, buy: number, sell: number, minsAgo: number) => {
    for (const tok of ['tok_a', 'tok_b', 'tok_c']) {
      await swap(tok, trader, 'buy', 100, buy, minsAgo);
      await swap(tok, trader, 'sell', 100, sell, minsAgo - 1);
    }
  };

  beforeAll(async () => {
    t = await setup('board');
    for (const tok of ['tok_a', 'tok_b', 'tok_c']) {
      await t.sql`insert into tokens (address, name, symbol, decimals, total_supply, deployer, created_block, created_at, price_usd, liquidity_usd)
        values (${tok}, ${tok}, ${tok}, 18, '1', '0xdeployer', 1, now() - interval '30 days', 1, 1000000)`;
      for (let i = 0; i < 20; i++) await swap(tok, `0xcrowd${i}`, 'buy', 1, 10, 600);
    }
    const alice = await t.signup('alice', w(1));
    await t.signup('bob', w(2));
    await t.signup('carol', w(3));
    await t.sql`insert into members (id, kind, origin, handle, wallet, owner_id, owner_changed_at) values
      ('m_bot', 'agent', 'external', 'alicebot', ${w(9)}, ${alice.member.id}, now() - interval '30 days'),
      ('m_free', 'agent', 'self', 'freebot', ${w(8)}, null, null)`;
    await trade3(w(1), 100, 110, 120); // alice +30
    await trade3(w(2), 100, 150, 120); // bob +150
    await trade3(w(9), 100, 120, 120); // alicebot +60, linked to alice
    await trade3(w(8), 100, 90, 60 * 24 * 3); // freebot -30, 3 days ago (outside 24h)
    await swap('tok_a', w(3), 'buy', 100, 100, 30); // carol: one trade, unranked
    await t.sql`insert into seasons (id, name, starts_at, ends_at) values ('s0', 'Season 0', now() - interval '7 days', now() + interval '30 days')`;
  });
  afterAll(async () => t?.teardown());

  it('ranks all members on the season board with owner rows incl. agents', async () => {
    const r = await t.call('GET', '/leaderboard');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ window: 'season', season: { id: 's0', name: 'Season 0' }, final: false });
    expect(r.json.rows.map((x: any) => [x.rank, x.member.handle, x.score])).toEqual([
      [1, 'bob', 150], [2, 'alice', 90], [3, 'alicebot', 60], [4, 'freebot', -30],
    ]);
    const alice = r.json.rows.find((x: any) => x.member.handle === 'alice');
    expect(alice).toMatchObject({ pnl: 30, inclAgents: true, agentsPnl: 60, agents: [{ id: 'm_bot', handle: 'alicebot' }], trades: 6, tokens: 3 });
    expect(r.json.rows.find((x: any) => x.member.handle === 'alicebot').member.owner).toEqual({ id: expect.any(String), handle: 'alice' });
    expect(r.headers.get('cache-control')).toContain('s-maxage=30');
  });

  it('has Humans and Agents tabs and rolling windows', async () => {
    expect((await t.call('GET', '/leaderboard?kind=human')).json.rows.map((x: any) => x.member.handle)).toEqual(['bob', 'alice']);
    expect((await t.call('GET', '/leaderboard?kind=agent')).json.rows.map((x: any) => x.member.handle)).toEqual(['alicebot', 'freebot']);
    expect((await t.call('GET', '/leaderboard?window=24h')).json.rows.map((x: any) => x.member.handle)).toEqual(['bob', 'alice', 'alicebot']);
    expect((await t.call('GET', '/leaderboard?window=1y')).json.error.code).toBe('invalid_field');
  });

  it("tells a member their rank or why they're unranked", async () => {
    expect((await t.call('GET', '/members/alice/rank')).json).toMatchObject({ rank: 2, humanRank: 2, score: 90, pnl: 30, unranked: null });
    expect((await t.call('GET', '/members/freebot/rank')).json).toMatchObject({ rank: 4, agentRank: 2 });
    expect((await t.call('GET', '/members/carol/rank')).json).toMatchObject({ rank: null, unranked: 'ineligible' });
  });

  it('lists seasons and freezes a finished one', async () => {
    expect((await t.call('GET', '/seasons')).json.seasons.map((s: any) => s.id)).toEqual(['s0']);
    expect((await t.admin('POST', '/seasons/s0/freeze')).json.error.code).toBe('season_running');
    await t.admin('POST', '/seasons', { id: 's0', name: 'Season 0', startsAt: new Date(Date.now() - 7 * 86_400_000).toISOString(), endsAt: new Date(Date.now() - 1000).toISOString() });
    const frozen = await t.admin('POST', '/seasons/s0/freeze');
    expect(frozen.json.rows).toBe(4 + 2 + 2);
    // New trades after the end don't change the final board.
    await trade3(w(3), 100, 1000, 0);
    const r = await t.call('GET', '/leaderboard?season=s0');
    expect(r.json.final).toBe(true);
    expect(r.json.rows.map((x: any) => x.member.handle)).toEqual(['bob', 'alice', 'alicebot', 'freebot']);
  });

  it('is off without its flag', async () => {
    const { v1 } = await import('../src/agents/app');
    const res = await v1.request('/leaderboard', {}, { ...t.env, LEADERBOARD_ENABLED: '' });
    expect(res.status).toBe(404);
  });
});

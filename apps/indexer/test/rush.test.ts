// Rush the Trenches standings (src/agents/rush.ts): the scoring rules, then the three boards against a
// throwaway local Postgres.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

import type { Sql } from 'postgres';
import { freshDb, pgAvailable } from '../../../packages/agents/test/pg';
import { bestPerMember, RUSH, rushStandings, scoreTrade } from '../src/agents/rush';

describe('scoreTrade', () => {
  it('scores the sold part at the average buy price', () => {
    // Bought 100 tokens for $50, sold half for $75: cost of the sold half is $25, so 3x and +$50.
    expect(scoreTrade({ memberId: 'a', token: 't', boughtUsd: 50, boughtTokens: 100, soldUsd: 75, soldTokens: 50, trades: 2 })).toEqual({
      costUsd: 25,
      pnlUsd: 50,
      multiplier: 3,
    });
  });
  it('skips trades under $20 in and trades with no sell', () => {
    expect(scoreTrade({ memberId: 'a', token: 't', boughtUsd: 19, boughtTokens: 10, soldUsd: 100, soldTokens: 10, trades: 2 })).toBeNull();
    expect(scoreTrade({ memberId: 'a', token: 't', boughtUsd: 50, boughtTokens: 10, soldUsd: 0, soldTokens: 0, trades: 1 })).toBeNull();
  });
  it('caps the sold share at what was bought in the window', () => {
    expect(scoreTrade({ memberId: 'a', token: 't', boughtUsd: 40, boughtTokens: 10, soldUsd: 60, soldTokens: 30, trades: 2 })!.multiplier).toBe(1.5);
  });
});

describe('bestPerMember', () => {
  it('keeps each member once, at their best, and ranks', () => {
    const out = bestPerMember(
      [
        { memberId: 'a', v: 2 },
        { memberId: 'a', v: 5 },
        { memberId: 'b', v: 3 },
      ],
      (x) => x.v,
    );
    expect(out.map((o) => [o.memberId, o.v, o.rank])).toEqual([
      ['a', 5, 1],
      ['b', 3, 2],
    ]);
  });
});

const ok = await pgAvailable();
describe.skipIf(!ok)('rushStandings (local Postgres)', () => {
  let db: { url: string; sql: Sql; drop: () => Promise<void> };
  const w = (n: number) => '0x' + String(n).repeat(40).slice(0, 40);
  const TOKEN = '0x' + 'a'.repeat(40);
  const OWN = '0x' + 'b'.repeat(40); // launched by bob
  const THIN = '0x' + 'c'.repeat(40); // $1K liquidity
  const during = new Date('2026-11-19T12:00:00Z');
  const before = new Date('2026-11-17T12:00:00Z');
  let n = 0;

  beforeAll(async () => {
    db = await freshDb('rush');
    const sql = db.sql;
    await sql`insert into members (id, kind, origin, handle, wallet, privy_did) values
      ('m_alice', 'human', null, 'alice', ${w(1)}, 'did:privy:alice'),
      ('m_bob', 'human', null, 'bob', ${w(2)}, 'did:privy:bob'),
      ('m_bot', 'agent', 'self', 'gainbot', ${w(3)}, null),
      ('m_talos', 'agent', 'self', 'talos', ${w(4)}, null)`;
    await sql`insert into tokens (address, name, symbol, decimals, total_supply, deployer, created_block, created_at, liquidity_usd, market_cap_usd) values
      (${TOKEN}, 'Good', 'GOOD', 18, '1', ${w(9)}, 1, now(), 20000, 100000),
      (${OWN}, 'Own', 'OWN', 18, '1', ${w(2)}, 1, now(), 20000, 100000),
      (${THIN}, 'Thin', 'THIN', 18, '1', ${w(9)}, 1, now(), 1000, 3000)`;
  });
  afterAll(async () => {
    await db?.drop();
  });

  /** One swap; `ledger` marks it as made through Rushr. */
  async function swap(trader: string, token: string, side: 'buy' | 'sell', usd: number, tokens: number, at = during, ledger = true) {
    n += 1;
    const tx = '0x' + n.toString(16).padStart(64, '0');
    await db.sql`insert into swaps (tx, log_index, token, pool, block, time, trader, side, token_amount, quote, quote_amount, usd, price_usd)
      values (${tx}, 0, ${token}, '0xpool', ${n}, ${new Date(at.getTime() + n * 1000)}, ${trader}, ${side}, ${tokens}, '0x0', '1', ${usd}, ${usd / tokens})`;
    if (ledger)
      await db.sql`insert into trades_ledger (id, chain_id, status, tx_hash, ts, trader, source_kind) values (${'l' + n}, 4663, 'confirmed', ${tx}, ${at}, ${trader}, 'web')`;
  }

  it('ranks gainers, traders and callers under the rules', async () => {
    // alice: $100 -> $300 on GOOD (3x, +$200). bob: $50 -> $250 on GOOD (5x, +$200) plus $100 -> $150 (1.5x, +$50) on OWN (his launch: skipped).
    await swap(w(1), TOKEN, 'buy', 100, 1000);
    await swap(w(1), TOKEN, 'sell', 300, 1000);
    await swap(w(2), TOKEN, 'buy', 50, 1000);
    await swap(w(2), TOKEN, 'sell', 250, 1000);
    await swap(w(2), OWN, 'buy', 100, 1000);
    await swap(w(2), OWN, 'sell', 150, 1000);
    // gainbot: 10x on a thin token (skipped), and 8x off-Rushr (no ledger row: skipped), and a $10 trade (under $20: skipped).
    await swap(w(3), THIN, 'buy', 100, 1000);
    await swap(w(3), THIN, 'sell', 1000, 1000);
    await swap(w(3), TOKEN, 'buy', 100, 1000, during, false);
    await swap(w(3), TOKEN, 'sell', 800, 1000, during, false);
    await swap(w(3), TOKEN, 'buy', 10, 100);
    await swap(w(3), TOKEN, 'sell', 90, 100);
    // talos: 20x, but Rushr's own agent. alice also traded before the event (doesn't count).
    await swap(w(4), TOKEN, 'buy', 50, 100);
    await swap(w(4), TOKEN, 'sell', 1000, 100);
    await swap(w(1), TOKEN, 'buy', 100, 1000, before);
    await swap(w(1), TOKEN, 'sell', 900, 1000, before);

    // Calls: alice calls GOOD at $0.10 and bought $100 on Rushr within the hour; the 1m high since is $0.40 (4x).
    // bob calls GOOD at $0.10 with no Rushr buy around it (skipped).
    await db.sql`insert into callouts (id, author_id, token, stance, body, price_at_post_usd, mcap_at_post_usd, created_at) values
      ('c_alice', 'm_alice', ${TOKEN}, 'bullish', 'sending it', 0.1, 10000, ${new Date(during.getTime() + 500)}),
      ('c_bob', 'm_bob', ${TOKEN}, 'bullish', 'me too', 0.1, 10000, ${new Date(during.getTime() - 3 * 3600_000)})`;
    await db.sql`insert into candles (token, interval, bucket, open, high, low, close, volume_usd, trades) values
      (${TOKEN}, '1m', ${new Date(during.getTime() + 60_000)}, 0.1, 0.4, 0.1, 0.3, 100, 3)`;

    const r = await rushStandings(db.sql, new Date('2026-11-20T00:00:00Z'));
    expect(r.status).toBe('live');
    expect(r.standings.gainer.map((g) => [g.member.handle, g.multiplier])).toEqual([
      ['bob', 5],
      ['alice', 3],
    ]);
    expect(r.standings.trader.map((t) => [t.member.handle, t.pnlUsd])).toEqual([
      ['alice', 200],
      ['bob', 200],
    ]);
    expect(r.standings.caller.map((c) => [c.member.handle, c.multiplier])).toEqual([['alice', 4]]);
  });

  it('is upcoming before the start and final at the end', async () => {
    expect((await rushStandings(db.sql, new Date('2026-11-17T00:00:00Z'))).status).toBe('upcoming');
    expect((await rushStandings(db.sql, new Date(RUSH.endsAt.getTime() + 1))).status).toBe('ended');
  });
});

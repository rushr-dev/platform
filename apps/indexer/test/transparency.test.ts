import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));

import type { Sql } from 'postgres';
import { RUSHR_TREASURY } from '@rushr/trade';
import { freshDb, pgAvailable } from '../../../packages/agents/test/pg';
import { feeTotals, formatUnits, transparency } from '../src/transparency';
import { resetPauseCache } from '../src/pause';
import { api } from '../src/api';

const ETH = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

describe('formatUnits', () => {
  it('formats raw amounts without float error', () => {
    expect(formatUnits('25457121929952', 18)).toBe('0.000025457121929952');
    expect(formatUnits(1_500_000n, 6)).toBe('1.5');
    expect(formatUnits('0', 6)).toBe('0');
  });
});

describe('feeTotals', () => {
  it('splits by token and by route', () => {
    const t = feeTotals(
      [
        { fee_token: ETH, route: 'curve', trades: 2, raw: '1000000000000000', usd: 1.76 },
        { fee_token: ETH, route: 'uniswap', trades: 1, raw: '500000000000000', usd: 0.88 },
        { fee_token: USDG, route: 'uniswap', trades: 3, raw: '2500000', usd: 2.5 },
      ],
      { trades: 6, traders: 4 },
    );
    expect(t).toMatchObject({ trades: 6, traders: 4, usd: 5.14 });
    expect(t.byToken.map((x) => [x.token, x.amount])).toEqual([['ETH', '0.0015'], ['USDG', '2.5']]);
    expect(t.byRoute.curve).toMatchObject({ trades: 2, usd: 1.76 });
    expect(t.byRoute.uniswap.byToken[1]).toMatchObject({ token: 'USDG', raw: '2500000' });
  });
});

const ok = await pgAvailable();
describe.skipIf(!ok)('GET /transparency (local Postgres)', () => {
  let db: { url: string; sql: Sql; drop: () => Promise<void> };
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} };
  const row = (id: string, o: Record<string, unknown>) => ({
    id, chain_id: 4663, status: 'confirmed', tx_hash: '0x' + id.padStart(64, '0'), ts: new Date('2026-11-14T10:00:00Z'),
    trader: '0x' + '1'.repeat(40), source_kind: 'web', fee_token: ETH, fee_amount: '1000000000000000', venue: 'uniswap', ...o,
  });

  beforeAll(async () => {
    db = await freshDb('transparency');
    const sql = db.sql;
    await sql`insert into indexer_state (key, value) values ('eth_usd', ${sql.json({ usd: 2000 })})`;
    await sql`insert into seasons (id, name, starts_at, ends_at) values ('s0', 'Season 0', now() - interval '1 day', now() + interval '29 days')`;
    await sql`insert into trades_ledger ${sql([
      row('1', { venue: 'pons-curve', ts: new Date() }),
      row('2', { trader: '0x' + '2'.repeat(40), ts: new Date(Date.now() - 3 * 86_400_000) }),
      row('3', { fee_token: USDG, fee_amount: '2500000', ts: new Date() }),
      row('4', { status: 'submitted', ts: new Date() }),
    ] as never)}`;
  });
  afterAll(async () => {
    resetPauseCache();
    await db?.drop();
  });

  it('totals confirmed fees all-time and for the current season, without trader addresses', async () => {
    resetPauseCache();
    const res = await api.request('/transparency', {}, { DATABASE_URL: db.url, RPC_URL: 'http://rpc.invalid', PUBLIC_RPC_URL: 'http://127.0.0.1:9' }, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('s-maxage=60');
    const body = (await res.json()) as Awaited<ReturnType<typeof transparency>>;
    expect(body.treasury.address).toBe(RUSHR_TREASURY);
    expect(body.treasury.explorer).toBe(`https://robinhoodchain.blockscout.com/address/${RUSHR_TREASURY}`);
    expect(body.feeRate).toMatchObject({ currentBps: 25, standardBps: 50, beta: true });
    expect(body.fees.allTime).toMatchObject({ trades: 3, traders: 2, usd: 6.5 });
    expect(body.fees.allTime.byRoute.curve.trades).toBe(1);
    expect(body.fees.allTime.byRoute.uniswap.trades).toBe(2);
    expect(body.fees.season).toMatchObject({ id: 's0', trades: 2, traders: 1, usd: 4.5 });
    expect(body.treasury.balances).toBeNull(); // RPC unreachable: null, not an error
    expect(body.buybacks).toEqual([]);
    expect(body.creatorTax).toMatchObject({ earned: { pending: null }, claimed: { claims: [] }, asOf: null });
    expect(JSON.stringify(body)).not.toContain('1'.repeat(40));
  });
});

describe('readBalances', () => {
  it('totals the Safe and the legacy treasury, and lists each account', async () => {
    const { readBalances } = await import('../src/transparency');
    const { LEGACY_TREASURIES } = await import('@rushr/trade');
    const legacy = LEGACY_TREASURIES[0]!.toLowerCase();
    const eth: Record<string, bigint> = { [RUSHR_TREASURY.toLowerCase()]: 10n ** 18n, [legacy]: 650_000_000_000_000n };
    const usdg: Record<string, bigint> = { [RUSHR_TREASURY.toLowerCase()]: 2_500_000n, [legacy]: 0n };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const calls = JSON.parse(String(init?.body)) as { id: number; method: string; params: [unknown, string] }[];
      return Response.json(calls.map((c) => {
        if (c.method === 'eth_getBalance') return { jsonrpc: '2.0', id: c.id, result: '0x' + eth[String(c.params[0]).toLowerCase()]!.toString(16) };
        const who = '0x' + (c.params[0] as { data: string }).data.slice(-40);
        return { jsonrpc: '2.0', id: c.id, result: '0x' + usdg[who]!.toString(16).padStart(64, '0') };
      }));
    }) as typeof fetch;
    try {
      const b = await readBalances('http://rpc.test', RUSHR_TREASURY);
      expect(b.ETH.amount).toBe('1.00065');
      expect(b.USDG.amount).toBe('2.5');
      expect(b.accounts!.map((a) => [a.address.toLowerCase(), a.role, a.ETH.amount])).toEqual([
        [RUSHR_TREASURY.toLowerCase(), 'current', '1'], [legacy, 'legacy', '0.00065'],
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

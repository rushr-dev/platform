// Trade ledger: POST /v1/trades + confirmation from the chain (receipt, our decoded swap, the treasury's
// fee from a call trace), referral accrual, and the member read endpoints. Local Postgres, fake RPC.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TRADE_CONFIG } from '@rushr/trade';
import { v1 } from '../src/agents/app';
import { confirmTrade, ethReceived, tokenFlow, trades } from '../src/ledger';
import { pgAvailable, setup } from './harness';

v1.route('/', trades);

const pg = await pgAvailable();
// Agents' body guard lets exactly a top-level txHash through on POST /v1/trades (a tx hash has a
// private key's shape); the handler verifies the hash on chain before storing anything.
const ALICE = '0xa11ce00000000000000000000000000000000001';
const BOB = '0xb0b0000000000000000000000000000000000002';
const CAROL = '0xca40100000000000000000000000000000000003';
const TOKEN = '0x7070000000000000000000000000000000000007';
const POOL = '0x9001000000000000000000000000000000000009';
const ROUTER = DEFAULT_TRADE_CONFIG.universalRouter.toLowerCase();
const TREASURY = DEFAULT_TRADE_CONFIG.feeRecipient.toLowerCase();
const BUY_TX = `0x${'b1'.repeat(32)}`;
const SELL_TX = `0x${'5e'.repeat(32)}`;
const E18 = 10n ** 18n;
const hex = (v: bigint) => `0x${v.toString(16)}`;
const topic = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const transfer = (token: string, from: string, to: string, v: bigint) => ({ address: token, topics: [TRANSFER, topic(from), topic(to)], data: `0x${v.toString(16).padStart(64, '0')}` });

/** Fake chain: a referred buy (1 ETH in, 45 bps fee to the treasury) and an unreferred sell (50 bps PAY_PORTION). */
const chain: Record<string, { tx: object; receipt: object; trace: object }> = {
  [BUY_TX]: {
    tx: { from: BOB, to: ROUTER, value: hex(E18) },
    receipt: { status: '0x1', blockNumber: '0x64', logs: [transfer(TOKEN, POOL, BOB, 1000n * E18)] },
    trace: { type: 'CALL', from: BOB, to: ROUTER, value: hex(E18), calls: [
      { type: 'CALL', from: ROUTER, to: TREASURY, value: hex((E18 * 45n) / 10_000n) },
      { type: 'CALL', from: ROUTER, to: POOL, value: '0x0', error: 'reverted', calls: [{ type: 'CALL', from: POOL, to: TREASURY, value: hex(E18) }] },
    ] },
  },
  [SELL_TX]: {
    tx: { from: CAROL, to: ROUTER, value: '0x0' },
    receipt: { status: '0x1', blockNumber: '0x65', logs: [transfer(TOKEN, CAROL, POOL, 500n * E18)] },
    // Gross 2 ETH out of the swap: 50 bps (0.01 ETH) to the treasury, 1.99 ETH swept to the seller.
    trace: { type: 'CALL', from: CAROL, to: ROUTER, value: '0x0', calls: [
      { type: 'CALL', from: ROUTER, to: TREASURY, value: hex(E18 / 100n) },
      { type: 'CALL', from: ROUTER, to: CAROL, value: hex((E18 * 199n) / 100n) },
    ] },
  },
};

function rpc(method: string, params: unknown[]): unknown {
  const tx = String(params[0]);
  if (method === 'eth_getTransactionReceipt') return chain[tx]?.receipt ?? null;
  if (method === 'eth_getTransactionByHash') return chain[tx]?.tx ?? null;
  if (method === 'debug_traceTransaction') return chain[tx]?.trace ?? null;
  if (method === 'eth_getBlockByNumber') return { timestamp: '0x6731a000' };
  throw new Error(`unexpected rpc ${method}`);
}

describe('trace and log helpers', () => {
  it('sums ETH to an address over successful frames only', () => {
    expect(ethReceived(chain[BUY_TX]!.trace as never, TREASURY)).toBe((E18 * 45n) / 10_000n);
  });
  it('nets ERC-20 flow from Transfer logs', () => {
    expect(tokenFlow((chain[SELL_TX]!.receipt as { logs: never[] }).logs, TOKEN, CAROL)).toBe(-500n * E18);
  });
});

describe.skipIf(!pg)('trade ledger', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  const queued: unknown[] = [];
  let bob: string;
  let alice: string;
  let carol: string;

  beforeAll(async () => {
    t = await setup('ledger');
    Object.assign(t.env, {
      RPC_URL: 'https://rpc.test/',
      ENRICH_QUEUE: { send: async (m: unknown) => void queued.push(m), sendBatch: async () => undefined },
    });
    alice = (await t.signup('alice', ALICE)).token;
    // Bob signs up with Alice's code: first-touch referral.
    bob = await t.human('did:privy:bob', BOB);
    expect((await t.call('POST', '/me', { auth: bob, body: { handle: 'bob', referralCode: 'Alice' } })).status).toBe(201);
    carol = (await t.signup('carol', CAROL)).token;
    // What the indexer would have decoded for these txs.
    await t.sql`insert into pools (id, token, quote, token_is_currency0, dex, venue, created_block, created_at)
      values (${POOL}, ${TOKEN}, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', true, 'v3', 'ramses', 1, now())`;
    await t.sql`insert into swaps (tx, log_index, token, pool, block, time, trader, side, token_amount, quote, quote_amount, price_usd, usd) values
      (${BUY_TX}, 1, ${TOKEN}, ${POOL}, 100, now(), ${BOB}, 'buy', ${(1000n * E18).toString()}, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', ${E18.toString()}, 1, 3000),
      (${SELL_TX}, 1, ${TOKEN}, ${POOL}, 101, now(), ${CAROL}, 'sell', ${(500n * E18).toString()}, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', ${(2n * E18).toString()}, 1, 6000)`;
    // RPC goes to the fake chain (Privy is only needed for sign-up above).
    vi.stubGlobal('fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
      const one = (r: { id: number; method: string; params: unknown[] }) => ({ jsonrpc: '2.0', id: r.id, result: rpc(r.method, r.params) });
      return Response.json(Array.isArray(body) ? body.map(one) : one(body));
    });
  });
  afterAll(async () => t?.teardown());

  it('records a submitted trade once, for the member who sent it', async () => {
    const r = await t.call('POST', '/trades', { auth: bob, body: { txHash: BUY_TX.toUpperCase().replace('0X', '0x'), chainId: 4663, source: { kind: 'web' } } });
    if (r.status !== 202) console.log('POST error', JSON.stringify(r.json));
    expect(r.status).toBe(202);
    expect(r.json.status).toBe('submitted');
    const confirms = () => queued.filter((m) => (m as { kind: string }).kind === 'trade-confirm');
    expect(confirms()).toEqual([{ kind: 'trade-confirm', tx: BUY_TX }]);
    const again = await t.call('POST', '/trades', { auth: bob, body: { txHash: BUY_TX, chainId: 4663, source: { kind: 'web' } } });
    expect(again.json.id).toBe(r.json.id);
    expect(confirms()).toHaveLength(1);
    // Carol can't claim Bob's tx (the chain says Bob sent it), and unknown hashes are never stored.
    expect((await t.call('POST', '/trades', { auth: carol, body: { txHash: BUY_TX, chainId: 4663 } })).json.error.code).toBe('not_your_tx');
    expect((await t.call('POST', '/trades', { auth: bob, body: { txHash: `0x${'ab'.repeat(32)}`, chainId: 4663 } })).json.error.code).toBe('tx_not_found');
    expect((await t.sql`select count(*)::int n from trades_ledger`)[0]!.n).toBe(1);
    // A key-shaped value in any other field is still refused by the guard.
    expect((await t.call('POST', '/trades', { auth: bob, body: { txHash: BUY_TX, chainId: 4663, privateKey: `0x${'cd'.repeat(32)}` } })).json.error.code).toBe('never_send_keys');
    expect((await t.call('POST', '/trades', { auth: bob, body: { txHash: '0x12', chainId: 4663 } })).json.error.code).toBe('bad_tx_hash');
    expect((await t.call('POST', '/trades', { auth: bob, body: { txHash: SELL_TX, chainId: 1 } })).json.error.code).toBe('bad_chain');
    expect((await t.call('POST', '/trades', { body: { txHash: SELL_TX, chainId: 4663 } })).status).toBe(401);
  });

  it('confirms a referred buy from the chain: fee from the trace, 45 bps, 20% accrual to the referrer', async () => {
    expect(await confirmTrade(t.sql, t.env as never, BUY_TX, false)).toBe('done');
    const [row] = await t.sql`select * from trades_ledger where tx_hash = ${BUY_TX}`;
    expect(row).toMatchObject({
      status: 'confirmed', side: 'buy', token: TOKEN, quote_asset: 'ETH', venue: 'ramses', pool_id: POOL, router: ROUTER,
      amount_in: E18.toString(), amount_out: (1000n * E18).toString(), fee_token: '0x0000000000000000000000000000000000000000',
      fee_amount: ((E18 * 45n) / 10_000n).toString(), base_fee_bps: 50, referrer: ALICE, referral_code: 'alice', referrer_share_bps: 2000,
      referrer_accrual: ((E18 * 45n * 2000n) / 10_000n / 10_000n).toString(), referral_discount: ((E18 * 5n) / 10_000n).toString(), flags: [],
    });
    expect(Number(row!.fee_bps)).toBeCloseTo(45);
  });

  it('confirms an unreferred sell: fee is the PAY_PORTION of the gross, amount_out what the seller got', async () => {
    await t.call('POST', '/trades', { auth: carol, body: { txHash: SELL_TX, chainId: 4663, source: { kind: 'api', id: 'bot-1' } } });
    await confirmTrade(t.sql, t.env as never, SELL_TX, false);
    const [row] = await t.sql`select * from trades_ledger where tx_hash = ${SELL_TX}`;
    expect(row).toMatchObject({
      status: 'confirmed', side: 'sell', amount_in: (500n * E18).toString(), amount_out: ((E18 * 199n) / 100n).toString(),
      fee_amount: (E18 / 100n).toString(), referrer: null, referrer_accrual: '0', source_kind: 'api', source_id: 'bot-1', flags: [],
    });
    expect(Number(row!.fee_bps)).toBeCloseTo(50);
  });

  it('serves the member their trades and the referrer their accruals', async () => {
    const mine = await t.call('GET', '/me/trades', { auth: bob });
    expect(mine.json.trades).toHaveLength(1);
    expect(mine.headers.get('cache-control')).toBe('private, no-store');
    const acc = await t.call('GET', '/me/referrals/accrued', { auth: alice });
    expect(acc.json.accrued).toEqual([
      { fee_token: '0x0000000000000000000000000000000000000000', trades: 1, confirmed_fee_amount: ((E18 * 45n) / 10_000n).toString(), referrer_accrual: ((E18 * 45n * 2000n) / 10_000n / 10_000n).toString() },
    ]);
  });
});

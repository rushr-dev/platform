// Trade ledger: POST /v1/trades + confirmation from the chain (receipt, our decoded swap, the treasury's
// fee from a call trace), referral accrual, and the member read endpoints. Local Postgres, fake RPC.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CURVE_BUY_TOPIC, CURVE_SELL_TOPIC, DEFAULT_TRADE_CONFIG, effectiveFeeBps } from '@rushr/trade';
import { v1 } from '../src/agents/app';
import { confirmTrade, ethReceived, sweepStuckTrades, tokenFlow, trades } from '../src/ledger';
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
// Rates from the trade config (0.25% during the beta, 0.22% referred), never literals.
const BASE_BPS = BigInt(DEFAULT_TRADE_CONFIG.feeBps);
const REF_BPS = BigInt(effectiveFeeBps(DEFAULT_TRADE_CONFIG, { referrer: TREASURY as `0x${string}` }));
const BUY_FEE = (E18 * REF_BPS) / 10_000n; // referred buy of 1 ETH
const SELL_GROSS = 2n * E18;
const SELL_FEE = (SELL_GROSS * BASE_BPS) / 10_000n; // unreferred sell, PAY_PORTION of the gross
const hex = (v: bigint) => `0x${v.toString(16)}`;
const topic = (a: string) => `0x${a.slice(2).padStart(64, '0')}`;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const transfer = (token: string, from: string, to: string, v: bigint) => ({ address: token, topics: [TRANSFER, topic(from), topic(to)], data: `0x${v.toString(16).padStart(64, '0')}` });

// Direct PONS curve trades: the curve call, then the fee as a plain transfer at the next nonce.
const CURVE = '0xc0c0000000000000000000000000000000000c0c';
const CTOKEN = '0x7171000000000000000000000000000000000071';
const CBUY_TX = `0x${'c1'.repeat(32)}`;
const CBUY_FEE_TX = `0x${'f1'.repeat(32)}`;
const CSELL_TX = `0x${'c5'.repeat(32)}`;
const CSELL_FEE_TX = `0x${'f5'.repeat(32)}`;
const CMISS_TX = `0x${'c9'.repeat(32)}`;
const CBAD_TX = `0x${'ca'.repeat(32)}`;
const CBAD_FEE_TX = `0x${'fa'.repeat(32)}`;
const CSTUCK_TX = `0x${'cb'.repeat(32)}`;
const CSTUCK_FEE_TX = `0x${'fb'.repeat(32)}`;
const CBUY_FEE = (E18 * REF_BPS) / 10_000n; // Bob is referred
const CSELL_FEE = (SELL_GROSS * BASE_BPS) / 10_000n; // Carol isn't
const word = (v: bigint) => v.toString(16).padStart(64, '0');
const fill = (side: 'buy' | 'sell', who: string, quote: bigint, tokens: bigint) => ({
  address: CURVE,
  topics: [side === 'buy' ? CURVE_BUY_TOPIC : CURVE_SELL_TOPIC, topic(who), topic(who)],
  data: `0x${side === 'buy' ? word(quote) + word(tokens) : word(tokens) + word(quote)}${word(quote / 100n)}${word(quote / 50n)}`,
});
const feeTx = (from: string, nonce: number, v: bigint) => ({
  tx: { from, to: TREASURY, value: hex(v), input: '0x', nonce: hex(BigInt(nonce)) },
  receipt: { status: '0x1', blockNumber: '0x70', logs: [] },
  trace: { type: 'CALL', from, to: TREASURY, value: hex(v) },
});

/** Fake chain: a referred buy (1 ETH in, the referred rate to the treasury) and an unreferred sell (the base rate as PAY_PORTION). */
const chain: Record<string, { tx: object; receipt: object; trace: object }> = {
  [BUY_TX]: {
    tx: { from: BOB, to: ROUTER, value: hex(E18) },
    receipt: { status: '0x1', blockNumber: '0x64', logs: [transfer(TOKEN, POOL, BOB, 1000n * E18)] },
    trace: { type: 'CALL', from: BOB, to: ROUTER, value: hex(E18), calls: [
      { type: 'CALL', from: ROUTER, to: TREASURY, value: hex(BUY_FEE) },
      { type: 'CALL', from: ROUTER, to: POOL, value: '0x0', error: 'reverted', calls: [{ type: 'CALL', from: POOL, to: TREASURY, value: hex(E18) }] },
    ] },
  },
  [SELL_TX]: {
    tx: { from: CAROL, to: ROUTER, value: '0x0' },
    receipt: { status: '0x1', blockNumber: '0x65', logs: [transfer(TOKEN, CAROL, POOL, 500n * E18)] },
    // Gross 2 ETH out of the swap: the base rate to the treasury, the rest swept to the seller.
    trace: { type: 'CALL', from: CAROL, to: ROUTER, value: '0x0', calls: [
      { type: 'CALL', from: ROUTER, to: TREASURY, value: hex(SELL_FEE) },
      { type: 'CALL', from: ROUTER, to: CAROL, value: hex(SELL_GROSS - SELL_FEE) },
    ] },
  },
  [CBUY_TX]: {
    tx: { from: BOB, to: CURVE, value: hex(E18), nonce: '0x7' },
    receipt: { status: '0x1', blockNumber: '0x6a', logs: [transfer(CTOKEN, CURVE, BOB, 1000n * E18), fill('buy', BOB, E18, 1000n * E18)] },
    trace: { type: 'CALL', from: BOB, to: CURVE, value: hex(E18) },
  },
  [CBUY_FEE_TX]: feeTx(BOB, 8, CBUY_FEE),
  [CSELL_TX]: {
    tx: { from: CAROL, to: CURVE, value: '0x0', nonce: '0x3' },
    receipt: { status: '0x1', blockNumber: '0x6b', logs: [transfer(CTOKEN, CAROL, CURVE, 500n * E18), fill('sell', CAROL, SELL_GROSS, 500n * E18)] },
    trace: { type: 'CALL', from: CAROL, to: CURVE, value: '0x0', calls: [{ type: 'CALL', from: CURVE, to: CAROL, value: hex(SELL_GROSS) }] },
  },
  [CSELL_FEE_TX]: feeTx(CAROL, 4, CSELL_FEE),
  [CMISS_TX]: {
    tx: { from: CAROL, to: CURVE, value: hex(E18), nonce: '0x9' },
    receipt: { status: '0x1', blockNumber: '0x6c', logs: [transfer(CTOKEN, CURVE, CAROL, 1000n * E18), fill('buy', CAROL, E18, 1000n * E18)] },
    trace: { type: 'CALL', from: CAROL, to: CURVE, value: hex(E18) },
  },
  [CBAD_TX]: {
    tx: { from: CAROL, to: CURVE, value: hex(E18), nonce: '0x10' },
    receipt: { status: '0x1', blockNumber: '0x6d', logs: [transfer(CTOKEN, CURVE, CAROL, 1000n * E18), fill('buy', CAROL, E18, 1000n * E18)] },
    trace: { type: 'CALL', from: CAROL, to: CURVE, value: hex(E18) },
  },
  [CSTUCK_TX]: {
    tx: { from: CAROL, to: CURVE, value: hex(E18), nonce: '0x20' },
    receipt: { status: '0x1', blockNumber: '0x6e', logs: [transfer(CTOKEN, CURVE, CAROL, 1000n * E18), fill('buy', CAROL, E18, 1000n * E18)] },
    trace: { type: 'CALL', from: CAROL, to: CURVE, value: hex(E18) },
  },
  [CSTUCK_FEE_TX]: feeTx(CAROL, 33, (E18 * BASE_BPS) / 10_000n),
  // Not the next nonce: some other transfer to the treasury, not this trade's fee.
  [CBAD_FEE_TX]: feeTx(CAROL, 40, (E18 * BASE_BPS) / 10_000n),
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
    expect(ethReceived(chain[BUY_TX]!.trace as never, TREASURY)).toBe(BUY_FEE);
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
    await t.sql`insert into pools (id, token, quote, token_is_currency0, dex, venue, created_block, created_at)
      values (${CURVE}, ${CTOKEN}, '0x0000000000000000000000000000000000000000', true, 'pons-curve', null, 1, now())`;
    const eth = '0x0000000000000000000000000000000000000000';
    await t.sql`insert into swaps (tx, log_index, token, pool, block, time, trader, side, token_amount, quote, quote_amount, price_usd, usd) values
      (${CBUY_TX}, 1, ${CTOKEN}, ${CURVE}, 106, now(), ${BOB}, 'buy', ${(1000n * E18).toString()}, ${eth}, ${E18.toString()}, 1, 3000),
      (${CSELL_TX}, 1, ${CTOKEN}, ${CURVE}, 107, now(), ${CAROL}, 'sell', ${(500n * E18).toString()}, ${eth}, ${SELL_GROSS.toString()}, 1, 6000),
      (${CMISS_TX}, 1, ${CTOKEN}, ${CURVE}, 108, now(), ${CAROL}, 'buy', ${(1000n * E18).toString()}, ${eth}, ${E18.toString()}, 1, 3000),
      (${CBAD_TX}, 1, ${CTOKEN}, ${CURVE}, 109, now(), ${CAROL}, 'buy', ${(1000n * E18).toString()}, ${eth}, ${E18.toString()}, 1, 3000),
      (${CSTUCK_TX}, 1, ${CTOKEN}, ${CURVE}, 110, now(), ${CAROL}, 'buy', ${(1000n * E18).toString()}, ${eth}, ${E18.toString()}, 1, 3000)`;
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

  it('confirms a referred buy from the chain: fee from the trace at the referred rate, 20% accrual to the referrer', async () => {
    expect(await confirmTrade(t.sql, t.env as never, BUY_TX, false)).toBe('done');
    const [row] = await t.sql`select * from trades_ledger where tx_hash = ${BUY_TX}`;
    expect(row).toMatchObject({
      status: 'confirmed', side: 'buy', token: TOKEN, quote_asset: 'ETH', venue: 'ramses', pool_id: POOL, router: ROUTER,
      amount_in: E18.toString(), amount_out: (1000n * E18).toString(), fee_token: '0x0000000000000000000000000000000000000000',
      fee_amount: BUY_FEE.toString(), base_fee_bps: Number(BASE_BPS), referrer: ALICE, referral_code: 'alice', referrer_share_bps: 2000,
      referrer_accrual: ((BUY_FEE * 2000n) / 10_000n).toString(), referral_discount: ((E18 * (BASE_BPS - REF_BPS)) / 10_000n).toString(), flags: [],
    });
    expect(Number(row!.fee_bps)).toBeCloseTo(Number(REF_BPS));
  });

  it('confirms an unreferred sell: fee is the PAY_PORTION of the gross, amount_out what the seller got', async () => {
    await t.call('POST', '/trades', { auth: carol, body: { txHash: SELL_TX, chainId: 4663, source: { kind: 'api', id: 'bot-1' } } });
    await confirmTrade(t.sql, t.env as never, SELL_TX, false);
    const [row] = await t.sql`select * from trades_ledger where tx_hash = ${SELL_TX}`;
    expect(row).toMatchObject({
      status: 'confirmed', side: 'sell', amount_in: (500n * E18).toString(), amount_out: (SELL_GROSS - SELL_FEE).toString(),
      fee_amount: SELL_FEE.toString(), base_fee_bps: Number(BASE_BPS), referrer: null, referrer_accrual: '0', source_kind: 'api', source_id: 'bot-1', flags: [],
    });
    expect(Number(row!.fee_bps)).toBeCloseTo(Number(BASE_BPS));
  });

  it('serves the member their trades and the referrer their accruals', async () => {
    const mine = await t.call('GET', '/me/trades', { auth: bob });
    expect(mine.json.trades).toHaveLength(1);
    expect(mine.headers.get('cache-control')).toBe('private, no-store');
    const acc = await t.call('GET', '/me/referrals/accrued', { auth: alice });
    expect(acc.json.accrued).toEqual([
      { fee_token: '0x0000000000000000000000000000000000000000', trades: 1, confirmed_fee_amount: BUY_FEE.toString(), referrer_accrual: ((BUY_FEE * 2000n) / 10_000n).toString() },
    ]);
  });

  describe('curve trades: the fee is a follow-up transfer at the next nonce', () => {
    const post = (auth: string, txHash: string, feeTxHash?: string) => t.call('POST', '/trades', { auth, body: { txHash, chainId: 4663, source: { kind: 'web' }, ...(feeTxHash ? { feeTxHash } : {}) } });
    const rowOf = async (h: string) => (await t.sql`select * from trades_ledger where tx_hash = ${h}`)[0]!;

    it('waits for the fee transfer, then confirms a referred buy at the referred rate', async () => {
      expect((await post(bob, CBUY_TX)).status).toBe(202);
      expect(await confirmTrade(t.sql, t.env as never, CBUY_TX, false)).toBe('retry');
      // Carol can't attach her transfer to Bob's trade.
      expect((await post(carol, CBUY_TX, CSELL_FEE_TX)).json.error.code).toBe('not_your_tx');
      expect((await post(bob, CBUY_TX, CBUY_FEE_TX)).status).toBe(202);
      expect(await confirmTrade(t.sql, t.env as never, CBUY_TX, false)).toBe('done');
      const row = await rowOf(CBUY_TX);
      expect(row).toMatchObject({
        status: 'confirmed', side: 'buy', router: CURVE, amount_in: E18.toString(), amount_out: (1000n * E18).toString(),
        fee_amount: CBUY_FEE.toString(), base_fee_bps: Number(BASE_BPS), referrer: ALICE, referrer_accrual: ((CBUY_FEE * 2000n) / 10_000n).toString(),
        flags: [`fee_tx:${CBUY_FEE_TX}`],
      });
      expect(Number(row.fee_bps)).toBeCloseTo(Number(REF_BPS));
      // A second, different fee hash for the same trade is ignored (first one wins).
      await post(bob, CBUY_TX, CSELL_FEE_TX).catch(() => undefined);
      expect((await rowOf(CBUY_TX)).flags).toEqual([`fee_tx:${CBUY_FEE_TX}`]);
    });

    it('a sell pays out of what the curve paid: amount_out is what the seller kept', async () => {
      await post(carol, CSELL_TX, CSELL_FEE_TX);
      expect(await confirmTrade(t.sql, t.env as never, CSELL_TX, false)).toBe('done');
      const row = await rowOf(CSELL_TX);
      expect(row).toMatchObject({ status: 'confirmed', side: 'sell', amount_out: (SELL_GROSS - CSELL_FEE).toString(), fee_amount: CSELL_FEE.toString(), referrer: null, flags: [`fee_tx:${CSELL_FEE_TX}`] });
      expect(Number(row.fee_bps)).toBeCloseTo(Number(BASE_BPS));
    });

    it('no fee transfer by the last attempt: confirmed with fee_missed; a late fee hash confirms it again', async () => {
      await post(carol, CMISS_TX);
      expect(await confirmTrade(t.sql, t.env as never, CMISS_TX, true)).toBe('done');
      expect(await rowOf(CMISS_TX)).toMatchObject({ status: 'confirmed', fee_amount: '0', flags: ['fee_missed'] });
      queued.length = 0;
      const r = await post(carol, CMISS_TX, CBAD_FEE_TX);
      expect(r.json.status).toBe('submitted');
      expect(queued).toEqual([{ kind: 'trade-confirm', tx: CMISS_TX }]);
    });

    it('a transfer that is not at the next nonce is not this trade\'s fee', async () => {
      await post(carol, CBAD_TX, CBAD_FEE_TX);
      expect(await confirmTrade(t.sql, t.env as never, CBAD_TX, false)).toBe('done');
      expect(await rowOf(CBAD_TX)).toMatchObject({ status: 'confirmed', fee_amount: '0', flags: [`fee_tx:${CBAD_FEE_TX}`, 'fee_tx_nonce_40_expected_17', 'fee_missed'] });
    });

    it('the cron sweep confirms a trade whose confirmation job never ran', async () => {
      // As seen live: the row and its fee hash were written, but no confirmation ever ran.
      await post(carol, CSTUCK_TX, CSTUCK_FEE_TX);
      await t.sql`update trades_ledger set updated_at = now() - interval '10 minutes' where tx_hash = ${CSTUCK_TX}`;
      const swept = await sweepStuckTrades(t.sql, t.env as never);
      expect(swept).toContainEqual({ tx: CSTUCK_TX, result: 'done' });
      expect(await rowOf(CSTUCK_TX)).toMatchObject({ status: 'confirmed', venue: 'pons-curve', side: 'buy', fee_amount: ((E18 * BASE_BPS) / 10_000n).toString(), flags: [`fee_tx:${CSTUCK_FEE_TX}`] });
      // Fresh rows are left to their own job.
      expect((await sweepStuckTrades(t.sql, t.env as never)).map((x) => x.tx)).not.toContain(CSTUCK_TX);
    });
  });
});

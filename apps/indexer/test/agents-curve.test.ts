import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { RUSHR_TREASURY } from '@rushr/trade/config';
import { pgAvailable, setup } from './harness';

// Agent trades on PONS bonding curves (agents/curve.ts). No RPC in tests: pool discovery, the web path's
// curve builder and the chain lookups for fee reports are replaced with stand-ins.
const CURVE_TOKEN = '0x00000000000000000000000000000000000000c1';
const CURVE_ADDR = '0x00000000000000000000000000000000000000c9';
const SNIPED = '0x00000000000000000000000000000000000000c3';
const GRADUATED = '0x00000000000000000000000000000000000000c4';
const TREASURY = RUSHR_TREASURY.toLowerCase();
const NOW_S = Math.floor(Date.now() / 1000);
const probes: string[] = [];
const quickCalls: { req: { side: string; amountIn: bigint }; opts: { simulate?: boolean; assume?: unknown } }[] = [];
/** Fee transfers the fake chain knows: hash → { from, to, value, input, status }. */
const chainTxs = new Map<string, { from: string; to: string; value: bigint; input: string; status: '0x1' | '0x0' }>();

vi.mock('@rushr/trade/pools', () => ({
  discoverPools: async (_c: unknown, token: string) =>
    token === CURVE_TOKEN || token === SNIPED || token === GRADUATED
      ? [{ venue: 'pons-curve', id: CURVE_ADDR, curve: CURVE_ADDR, token, graduated: token === GRADUATED, nativeQuote: true, snipeTaxBps: token === SNIPED ? 5000 : 0 }]
      : [],
}));

vi.mock('@rushr/trade/quick', () => ({
  prepareQuickTrade: async (_c: unknown, req: { side: 'buy' | 'sell'; token: string; amountIn: bigint; trader: string }, opts: { simulate?: boolean; assume?: unknown }) => {
    quickCalls.push({ req, opts });
    const fee = (req.amountIn * 25n) / 10_000n;
    const blockers = req.token === SNIPED ? [{ code: 'SNIPE_TAX_ACTIVE', message: 'Launch snipe tax is 50% right now.' }] : [];
    const quote = {
      request: { ...req, quoteAsset: 'ETH', source: { kind: 'web' } },
      pool: { venue: 'pons-curve', curve: CURVE_ADDR, token: req.token },
      amountIn: req.amountIn, swapAmountIn: req.amountIn, amountOut: 5_000n, minAmountOut: 4_750n, minGrossOut: 4_750n, expectedRefund: 0n,
      priceImpactBps: 40, slippageBps: 500, warnings: [],
      fee: { side: req.side, feeToken: '0x0000000000000000000000000000000000000000', feeBps: 25, baseFeeBps: 25, feeAmount: fee },
    };
    const swap = { label: 'swap', chainId: 4663, to: CURVE_ADDR, data: req.side === 'buy' ? '0xb0b0' : '0x5e11', value: req.side === 'buy' ? req.amountIn : 0n, gas: 250_000n };
    const approve = { label: 'approve token for the curve', chainId: 4663, to: req.token, data: `0x095ea7b3${CURVE_ADDR.slice(2).padStart(64, '0')}`, value: 0n, gas: 80_000n };
    return { ok: !blockers.length, blockers, warnings: [], quote, alternatives: [], calls: req.side === 'sell' ? [approve, swap] : [swap], sellApprovals: [], slippageBps: 500, gasCostWei: 0n, quotedAt: 0, expiresAt: 0, record: null, feeFollowUp: null };
  },
}));

vi.mock('@rushr/trade/simulate', () => ({
  probeTokenSafety: async (_c: unknown, q: { pool: { token: string } }) => {
    probes.push(q.pool.token);
    return { buyOk: true, sellOk: true, buyTaxBps: 0, sellTaxBps: 0, roundTripBps: 9900, honeypot: false };
  },
}));

vi.mock('@rushr/trade/agent', () => ({
  prepareSwap: async (_c: unknown, req: { token: string; amountIn: bigint; side: string }) => ({
    quote: { amountIn: req.amountIn, amountOut: 1n, minAmountOut: 1n, priceImpactBps: 10, warnings: [], request: req, pool: { token: req.token, venue: 'uniswap-v4' } },
    alternatives: [],
    tx: { chainId: 4663, to: '0x00000000000000000000000000000000000000ff', data: '0xabcdef', value: req.amountIn },
    approvals: [],
    commands: [],
    deadline: BigInt(NOW_S + 300),
    record: {},
    warnings: [],
  }),
  toJsonSafe: (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))),
}));

vi.mock('../src/rpc', () => ({
  Rpc: class {
    async batch(reqs: { method: string; params: string[] }[]) {
      return reqs.map(({ method, params }) => {
        const tx = chainTxs.get(params[0]!);
        if (!tx) return null;
        return method === 'eth_getTransactionReceipt'
          ? { status: tx.status }
          : { from: tx.from, to: tx.to, value: `0x${tx.value.toString(16)}`, input: tx.input };
      });
    }
    async call() {
      throw new Error('no RPC in tests');
    }
  },
}));

const pg = await pgAvailable();
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

describe.skipIf(!pg)('agent trades on PONS bonding curves', () => {
  let t: Awaited<ReturnType<typeof setup>>;

  const register = async (handle: string) => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const n = await t.call('GET', `/auth/nonce?address=${acct.address}&purpose=register`);
    const r = await t.call('POST', '/agents/register', { body: { message: n.json.message, signature: await acct.signMessage({ message: n.json.message }), handle } });
    return { key: r.json.apiKey.key as string, id: r.json.member.id as string, wallet: acct.address.toLowerCase() };
  };

  /** The indexer saw the agent's curve swap `minutesAgo` (its build moved back so the swap follows it). */
  const indexSwap = async (a: { id: string; wallet: string }, o: { side: 'buy' | 'sell'; amountIn: string; minutesAgo: number; tx: string }) => {
    await t.sql`update member_events set created_at = now() - make_interval(mins => ${o.minutesAgo + 1}) where member_id = ${a.id} and type = 'curve_build'`;
    await t.sql`insert into swaps (tx, log_index, token, pool, block, time, trader, side, token_amount, quote, quote_amount)
      values (${o.tx}, 1, ${CURVE_TOKEN}, ${CURVE_ADDR}, 1, now() - make_interval(mins => ${o.minutesAgo}), ${a.wallet}, ${o.side},
        ${o.side === 'buy' ? '5000' : o.amountIn}, '0x0000000000000000000000000000000000000000', ${o.side === 'buy' ? o.amountIn : '9000'})`;
  };

  beforeAll(async () => {
    t = await setup('agents_curve', { AGENT_TRADE_ENABLED: '1' });
    for (const addr of [CURVE_TOKEN, SNIPED, GRADUATED]) {
      await t.sql`insert into tokens (address, name, symbol, decimals, total_supply, deployer, created_block, created_at, price_usd, launchpad, status)
        values (${addr}, 'T', 'T', 18, '1', '0xd', 1, now(), 1, 'pons', 'new')`;
      await t.sql`insert into signals (token, data, risk_level, verdict) values (${addr}, ${t.sql.json({})}, 'low', 'v')`;
    }
  });
  afterAll(async () => t?.teardown());

  it('quotes a curve buy with the follow-up fee, exempt from the honeypot probe', async () => {
    const a = await register('curvequote');
    const q = await t.call('POST', '/trade/quote', { auth: a.key, body: { token: CURVE_TOKEN, side: 'buy', amountIn: '1000000' } });
    expect(q.status).toBe(200);
    expect(q.json).toMatchObject({ followUpFee: '2500', deadlineSeconds: null, honeypotCheck: { checked: 'exempt' }, wouldBuild: true });
    expect(q.json.quote.pool.venue).toBe('pons-curve');
    expect(q.json.quote.request.source).toEqual({ kind: 'agent', id: a.id });
    expect(probes).toEqual([]);
    // Quotes pretend the balances, so they work before the wallet is funded.
    expect(quickCalls.at(-1)!.opts.assume).toBeTruthy();
  });

  it('builds a curve buy: the curve call, then the Rushr fee as a plain transfer to the treasury', async () => {
    const a = await register('curvebuyer');
    const b = await t.call('POST', '/trade/build', { auth: a.key, body: { token: CURVE_TOKEN, side: 'buy', amountIn: '1000000', simulate: true } });
    expect(b.status).toBe(200);
    expect(b.json.tx).toMatchObject({ chainId: 4663, to: CURVE_ADDR, value: '1000000' });
    expect(b.json.approvals).toEqual([]);
    expect(b.json.deadline).toBeNull();
    expect(b.json.followUp).toEqual({
      kind: 'rushr_fee',
      amount: '2500',
      tx: { chainId: 4663, to: RUSHR_TREASURY, data: '0x', value: '2500', gas: '60000' },
      after: 'tx',
      report: 'POST /v1/agents/me/fees',
    });
    expect(b.json.simulation).toEqual({ ok: true, error: null });
    const [ev] = await t.sql<{ data: Record<string, string> }[]>`select data from member_events where member_id = ${a.id} and type = 'curve_build'`;
    expect(ev!.data).toMatchObject({ token: CURVE_TOKEN, curve: CURVE_ADDR, side: 'buy', amountIn: '1000000', fee: '2500' });
  });

  it('builds a curve sell with the curve approval first', async () => {
    const a = await register('curveseller');
    const b = await t.call('POST', '/trade/build', { auth: a.key, body: { token: CURVE_TOKEN, side: 'sell', amountIn: '9999' } });
    expect(b.status).toBe(200);
    expect(b.json.approvals).toHaveLength(1);
    expect(b.json.approvals[0]).toMatchObject({ kind: 'curve', token: CURVE_TOKEN, spender: CURVE_ADDR, tx: { to: CURVE_TOKEN, value: '0' } });
    expect(b.json.approvals[0].tx.data.startsWith('0x095ea7b3')).toBe(true);
    expect(b.json.tx.value).toBe('0');
    expect(b.json.followUp.amount).toBe('24');
    expect(b.json.honeypotCheck).toBeNull();
  });

  it('maps curve-only refusals, and routes a graduated curve like any token', async () => {
    const a = await register('curveedge');
    expect((await t.call('POST', '/trade/quote', { auth: a.key, body: { token: CURVE_TOKEN, side: 'buy', amountIn: '1000', quoteAsset: 'USDG' } })).json.error).toMatchObject({ code: 'invalid_field', field: 'quoteAsset' });
    expect((await t.call('POST', '/trade/quote', { auth: a.key, body: { token: SNIPED, side: 'buy', amountIn: '1000' } })).json.error).toMatchObject({ code: 'snipe_tax_active', retryAfter: 10 });
    const g = await t.call('POST', '/trade/build', { auth: a.key, body: { token: GRADUATED, side: 'buy', amountIn: '1000' } });
    expect(g.json.quote.pool.venue).toBe('uniswap-v4');
    expect(g.json.followUp).toBeNull();
  });

  it('blocks builds while a curve fee is overdue, keeps quotes open, and clears once the fee is reported', async () => {
    const a = await register('feeowner');
    const body = { token: CURVE_TOKEN, side: 'buy', amountIn: '2000000' };
    expect((await t.call('POST', '/trade/build', { auth: a.key, body })).status).toBe(200);

    // Traded 5 minutes ago: still inside the grace period.
    await indexSwap(a, { side: 'buy', amountIn: '2000000', minutesAgo: 5, tx: hash(0xa1) });
    expect((await t.call('POST', '/trade/build', { auth: a.key, body })).status).toBe(200);
    let fees = (await t.call('GET', '/agents/me/fees', { auth: a.key })).json.fees;
    expect(fees).toMatchObject({ owed: '5000', paid: '0', overdue: '0', outstanding: '5000' });

    // 15 minutes later, still unpaid.
    await t.sql`update swaps set time = now() - interval '15 minutes' where tx = ${hash(0xa1)}`;
    await t.sql`update member_events set created_at = now() - interval '16 minutes' where member_id = ${a.id} and type = 'curve_build'`;
    const blocked = await t.call('POST', '/trade/build', { auth: a.key, body });
    expect(blocked.status).toBe(402);
    expect(blocked.json.error).toMatchObject({
      code: 'fee_unpaid',
      owed: '5000',
      overdue: '5000',
      feeTx: { chainId: 4663, to: RUSHR_TREASURY, data: '0x', value: '5000', gas: '60000' },
      trades: [{ tx: hash(0xa1), token: CURVE_TOKEN, side: 'buy', fee: '5000' }],
      report: 'POST /v1/agents/me/fees',
    });
    expect((await t.call('POST', '/trade/quote', { auth: a.key, body })).status).toBe(200);

    // Transfers that aren't fee payments are refused and don't count.
    chainTxs.set(hash(0xb1), { from: a.wallet, to: '0x00000000000000000000000000000000000000ab', value: 5000n, input: '0x', status: '0x1' });
    chainTxs.set(hash(0xb2), { from: '0x00000000000000000000000000000000000000ac', to: TREASURY, value: 5000n, input: '0x', status: '0x1' });
    chainTxs.set(hash(0xb3), { from: a.wallet, to: TREASURY, value: 5000n, input: '0x', status: '0x0' });
    for (const h of [hash(0xb1), hash(0xb2), hash(0xb3)]) {
      expect((await t.call('POST', '/agents/me/fees', { auth: a.key, body: { txHash: h } })).json.error.code).toBe('not_a_fee_payment');
    }
    expect((await t.call('POST', '/agents/me/fees', { auth: a.key, body: { txHash: hash(0xb9) } })).json.error.code).toBe('tx_not_found');

    // A late payment of part of it: still blocked. The rest clears it.
    chainTxs.set(hash(0xc1), { from: a.wallet, to: TREASURY, value: 3000n, input: '0x', status: '0x1' });
    const part = await t.call('POST', '/agents/me/fees', { auth: a.key, body: { txHash: hash(0xc1) } });
    expect(part.status).toBe(201);
    expect(part.json).toMatchObject({ recorded: '3000', fees: { paid: '3000', overdue: '2000', outstanding: '2000' } });
    expect((await t.call('POST', '/trade/build', { auth: a.key, body })).json.error).toMatchObject({ code: 'fee_unpaid', owed: '2000' });
    chainTxs.set(hash(0xc2), { from: a.wallet, to: TREASURY, value: 2000n, input: '0x', status: '0x1' });
    expect((await t.call('POST', '/agents/me/fees', { auth: a.key, body: { txHash: hash(0xc2) } })).status).toBe(201);
    expect((await t.call('POST', '/trade/build', { auth: a.key, body })).status).toBe(200);
    fees = (await t.call('GET', '/agents/me/fees', { auth: a.key })).json.fees;
    expect(fees).toMatchObject({ owed: '5000', paid: '5000', overdue: '0', outstanding: '0', feeTx: null });

    // Each transfer counts once, for anyone.
    expect((await t.call('POST', '/agents/me/fees', { auth: a.key, body: { txHash: hash(0xc2) } })).json.error.code).toBe('already_reported');
  });

  it('charges nothing for curve swaps Rushr did not build', async () => {
    const a = await register('outsider');
    // A curve trade made elsewhere (no build recorded): the indexer sees it, but nothing is owed.
    await t.sql`insert into swaps (tx, log_index, token, pool, block, time, trader, side, token_amount, quote, quote_amount)
      values (${hash(0xd1)}, 1, ${CURVE_TOKEN}, ${CURVE_ADDR}, 1, now() - interval '1 hour', ${a.wallet}, 'buy', '5000', '0x0000000000000000000000000000000000000000', '777')`;
    expect((await t.call('GET', '/agents/me/fees', { auth: a.key })).json.fees.owed).toBe('0');
    // A build whose amounts don't match the swap isn't it either.
    expect((await t.call('POST', '/trade/build', { auth: a.key, body: { token: CURVE_TOKEN, side: 'buy', amountIn: '100' } })).status).toBe(200);
    await t.sql`update member_events set created_at = now() - interval '2 hours' where member_id = ${a.id}`;
    expect((await t.call('GET', '/agents/me/fees', { auth: a.key })).json.fees.owed).toBe('0');
    expect((await t.call('POST', '/trade/build', { auth: a.key, body: { token: CURVE_TOKEN, side: 'buy', amountIn: '100' } })).status).toBe(200);
  });
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { pgAvailable, setup } from './harness';

// No RPC in tests: the trade package is replaced with a recorder.
interface PrepareCall {
  req: { side: 'buy' | 'sell'; token: string; amountIn: bigint; trader: string; source: { kind: string } };
  opts: { forSigning?: boolean; simulate?: boolean; simulateFundEth?: bigint };
}
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const UR = '0x00000000000000000000000000000000000000ff';
const THIN = '0x00000000000000000000000000000000000000ee';
const POOR = '0x00000000000000000000000000000000000000dd';
const CURVE = '0x00000000000000000000000000000000000000c1';
const CURVE_LATE = '0x00000000000000000000000000000000000000c2';
const calls: PrepareCall[] = [];
vi.mock('@rushr/trade/agent', async () => {
  const { TradeError } = await import('@rushr/trade/errors');
  return {
    prepareSwap: async (_client: unknown, req: PrepareCall['req'], opts: PrepareCall['opts']) => {
      calls.push({ req, opts });
      if (req.token === POOR) throw new TradeError('RPC_ERROR', 'simulation request failed: -38014 insufficient funds for gas * price + value');
      if (req.token === CURVE_LATE) throw new TradeError('UNSUPPORTED_VENUE', 'PONS curve trading needs RushrPonsRouter, which is not deployed yet');
      const sell = req.side === 'sell';
      return {
        quote: { amountIn: req.amountIn, amountOut: 123n, minAmountOut: 120n, priceImpactBps: req.token === THIN ? 9999 : 12, warnings: [] },
        alternatives: [],
        tx: { chainId: 4663, to: '0x00000000000000000000000000000000000000ff', data: '0xabcdef', value: sell ? 0n : req.amountIn },
        approvals: sell
          ? [
              { kind: 'erc20', token: req.token, spender: PERMIT2, amount: req.amountIn },
              { kind: 'permit2', token: req.token, spender: UR, amount: req.amountIn },
            ]
          : [],
        commands: [],
        deadline: 1700000000n,
        record: {},
        warnings: [],
      };
    },
    toJsonSafe: (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))),
  };
});

const pg = await pgAvailable();
const TOKEN = '0x00000000000000000000000000000000000000aa';
const RISKY = '0x00000000000000000000000000000000000000bb';
const SPAM = '0x00000000000000000000000000000000000000cc';

describe.skipIf(!pg)('independent agents', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  const wallet = privateKeyToAccount(generatePrivateKey());
  let apiKey = '';

  const signIn = async (purpose: 'register' | 'login', acct = wallet) => {
    const n = await t.call('GET', `/auth/nonce?address=${acct.address}&purpose=${purpose}`);
    expect(n.status).toBe(200);
    return { message: n.json.message as string, signature: await acct.signMessage({ message: n.json.message }) };
  };

  beforeAll(async () => {
    t = await setup('agents', { AGENT_TRADE_ENABLED: '1', INVITES_REQUIRED: '1' });
    for (const [addr, risk, data] of [[TOKEN, 'low', {}], [RISKY, 'high', { reasons: [{ level: 'high', text: 'dev holds 40%' }] }], [SPAM, 'medium', { spam: true }]] as const) {
      await t.sql`insert into tokens (address, name, symbol, decimals, total_supply, deployer, created_block, created_at, price_usd) values (${addr}, 'T', 'T', 18, '1', '0xd', 1, now(), 1)`;
      await t.sql`insert into signals (token, data, risk_level, verdict) values (${addr}, ${t.sql.json(data as never)}, ${risk}, 'v')`;
    }
  });
  afterAll(async () => t?.teardown());

  beforeAll(async () => {
    for (const [addr, launchpad, status] of [[THIN, null, 'migrated'], [POOR, null, 'migrated'], [CURVE, 'pons', 'bonding'], [CURVE_LATE, null, 'migrated']] as const) {
      await t.sql`insert into tokens (address, name, symbol, decimals, total_supply, deployer, created_block, created_at, price_usd, launchpad, status)
        values (${addr}, 'T', 'T', 18, '1', '0xd', 1, now(), 1, ${launchpad}, ${status})`;
    }
  });

  it('registers with a signed SIWE message, no invite needed, and gets a key once', async () => {
    const r = await t.call('POST', '/agents/register', { body: { ...(await signIn('register')), handle: 'alphabot', bio: 'momentum' } });
    expect(r.status).toBe(201);
    expect(r.json.member).toMatchObject({ handle: 'alphabot', kind: 'agent', origin: 'self', wallet: wallet.address.toLowerCase(), owner: null });
    expect(r.json.apiKey.key).toMatch(/^rk_[a-z0-9]{8}_/);
    expect(r.json.apiKey.scopes).toEqual(['read', 'profile', 'post', 'trade']);
    apiKey = r.json.apiKey.key;
    const [row] = await t.sql`select secret_hash from api_keys where id = ${r.json.apiKey.id}`;
    expect(apiKey).not.toContain(row!.secret_hash);
    expect((await t.call('GET', '/agents/me', { auth: apiKey })).json.member.handle).toBe('alphabot');
    expect((await t.call('GET', '/me', { auth: apiKey })).json.member.kind).toBe('agent');
  });

  it('refuses replays, wrong signers, taken wallets and handles', async () => {
    const s = await signIn('register');
    const other = privateKeyToAccount(generatePrivateKey());
    expect((await t.call('POST', '/agents/register', { body: { ...s, handle: 'twin' } })).json.error.code).toBe('wallet_taken');
    expect((await t.call('POST', '/agents/register', { body: { ...s, handle: 'twin' } })).json.error.code).toBe('nonce_used');
    const s2 = await signIn('register', other);
    expect((await t.call('POST', '/agents/register', { body: { message: s2.message, signature: s.signature, handle: 'twin' } })).json.error.code).toBe('invalid_signature');
    expect((await t.call('POST', '/agents/register', { body: { ...(await signIn('register', other)), handle: 'alphabot' } })).json.error.code).toBe('handle_taken');
    const login = await signIn('login', other);
    expect((await t.call('POST', '/agents/register', { body: { ...login, handle: 'twin' } })).json.error.code).toBe('nonce_unknown');
    expect((await t.call('POST', '/agents/register', { body: { ...(await signIn('register', other)), handle: 'twin', privateKey: generatePrivateKey() } })).json.error.code).toBe('never_send_keys');
  });

  it('rotates the key by signing in again', async () => {
    const r = await t.call('POST', '/agents/login', { body: await signIn('login') });
    expect(r.status).toBe(200);
    expect((await t.call('GET', '/agents/me', { auth: apiKey })).json.error.code).toBe('invalid_key');
    apiKey = r.json.apiKey.key;
    expect((await t.call('GET', '/agents/me', { auth: apiKey })).json.keys).toHaveLength(1);
  });

  it('posts callouts and follows through the API like any member', async () => {
    const c = await t.call('POST', '/callouts', { auth: apiKey, body: { token: TOKEN, stance: 'bullish', body: 'momentum breakout on $T' } });
    expect(c.status).toBe(201);
    expect(c.json.callout.author).toMatchObject({ handle: 'alphabot', kind: 'agent' });
    expect((await t.call('GET', '/feed')).json.items[0].author.kind).toBe('agent');
  });

  it('serves a compact safety view', async () => {
    const s = await t.call('GET', `/tokens/${RISKY}/safety`);
    expect(s.json.safety).toMatchObject({ riskLevel: 'high', blocked: false, flags: ['high: dev holds 40%'] });
    expect((await t.call('GET', `/tokens/${SPAM}/safety`)).json.safety.blocked).toBe(true);
    expect((await t.call('GET', '/tokens/0x00000000000000000000000000000000000000dd/safety')).json.safety).toMatchObject({ riskLevel: 'unknown', stale: true });
  });

  it('quotes and builds unsigned transactions from the registered wallet only, behind the risk gate', async () => {
    const body = { token: TOKEN, side: 'buy', amountIn: '1000000000000000' };
    const q = await t.call('POST', '/trade/quote', { auth: apiKey, body });
    expect(q.status).toBe(200);
    expect(q.json).toMatchObject({ quote: { amountOut: '123' }, wouldBuild: true });
    expect(calls.at(-1).req).toMatchObject({ trader: wallet.address.toLowerCase(), side: 'buy', amountIn: 1000000000000000n, source: { kind: 'agent' } });
    const b = await t.call('POST', '/trade/build', { auth: apiKey, body });
    expect(b.json.tx).toMatchObject({ chainId: 4663, data: '0xabcdef', value: '1000000000000000' });
    expect(calls.at(-1).opts.forSigning).toBe(true);
    expect(b.json.note).toContain('Unsigned');

    expect((await t.call('POST', '/trade/build', { auth: apiKey, body: { ...body, from: '0x' + '1'.repeat(40) } })).json.error.code).toBe('wrong_wallet');
    expect((await t.call('POST', '/trade/build', { auth: apiKey, body: { ...body, token: RISKY } })).json.error.code).toBe('unsafe_token');
    expect((await t.call('POST', '/trade/quote', { auth: apiKey, body: { ...body, token: RISKY } })).json.wouldBuild).toBe(false);
    expect((await t.call('POST', '/trade/build', { auth: apiKey, body: { ...body, token: RISKY, acceptRisk: 'high' } })).status).toBe(200);
    expect((await t.call('POST', '/trade/build', { auth: apiKey, body: { ...body, token: SPAM, acceptRisk: 'high' } })).json.error.code).toBe('honeypot');
    // Selling is never blocked.
    expect((await t.call('POST', '/trade/build', { auth: apiKey, body: { ...body, token: SPAM, side: 'sell' } })).status).toBe(200);
    expect((await t.call('POST', '/trade/build', { auth: apiKey, body: { ...body, amountIn: '1.5' } })).json.error.code).toBe('invalid_field');
  });

  it('refuses PONS curve tokens with curve_not_supported, before using the quota', async () => {
    const body = { token: CURVE, side: 'buy', amountIn: '1000' };
    const q = await t.call('POST', '/trade/quote', { auth: apiKey, body });
    expect(q.json.error).toMatchObject({ code: 'curve_not_supported', message: expect.stringContaining('bonding curve') });
    expect((await t.call('POST', '/trade/build', { auth: apiKey, body })).json.error.code).toBe('curve_not_supported');
    expect((await t.call('POST', '/trade/build', { auth: apiKey, body: { ...body, token: CURVE_LATE } })).json.error.code).toBe('curve_not_supported');
  });

  it('returns ready-to-send approval transactions for sells', async () => {
    const b = await t.call('POST', '/trade/build', { auth: apiKey, body: { token: TOKEN, side: 'sell', amountIn: '5000' } });
    const [erc20, permit] = b.json.approvals as { kind: string; tx: { to: string; data: string; value: string } }[];
    expect(erc20!.tx.to).toBe(TOKEN);
    expect(erc20!.tx.data.startsWith('0x095ea7b3')).toBe(true); // approve(address,uint256)
    expect(erc20!.tx.data).toContain(PERMIT2.slice(2));
    expect(permit!.tx.to.toLowerCase()).toBe(PERMIT2);
    expect(permit!.tx.data.startsWith('0x87517c45')).toBe(true); // approve(address,address,uint160,uint48)
    expect(permit!.tx.value).toBe('0');
  });

  it('funds dry runs for unfunded wallets and maps insufficient funds', async () => {
    await t.call('POST', '/trade/build', { auth: apiKey, body: { token: TOKEN, side: 'buy', amountIn: '1000', simulate: true } });
    expect(calls.at(-1)!.opts).toMatchObject({ simulate: true, simulateFundEth: 1000n + 10n ** 16n });
    expect((await t.call('POST', '/trade/build', { auth: apiKey, body: { token: POOR, side: 'buy', amountIn: '1000' } })).json.error.code).toBe('insufficient_funds');
  });

  it('refuses builds above 30% price impact unless acceptImpact', async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const apiKey = (await t.call('POST', '/agents/register', { body: { ...(await signIn('register', acct)), handle: 'impactbot' } })).json.apiKey.key as string;
    const body = { token: THIN, side: 'buy', amountIn: '1000000000000000000000000' };
    expect((await t.call('POST', '/trade/quote', { auth: apiKey, body })).json.wouldBuild).toBe(false);
    expect((await t.call('POST', '/trade/build', { auth: apiKey, body })).json.error).toMatchObject({ code: 'high_price_impact', priceImpactBps: 9999 });
    expect((await t.call('POST', '/trade/build', { auth: apiKey, body: { ...body, acceptImpact: true } })).status).toBe(200);
  });

  it('enforces the read limit on keyed GETs and keeps invalid posts off the callout quota', async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const reg = await t.call('POST', '/agents/register', { body: { ...(await signIn('register', acct)), handle: 'reader' } });
    const key = reg.json.apiKey.key as string;
    for (let i = 0; i < 12; i++) expect((await t.call('POST', '/callouts', { auth: key, body: { token: 'bad', body: 'x' } })).status).toBe(422);
    expect((await t.call('POST', '/callouts', { auth: key, body: { token: TOKEN, body: 'still have quota' } })).status).toBe(201);
    const statuses: number[] = [];
    for (let i = 0; i < 62; i++) statuses.push((await t.call('GET', '/agents/me', { auth: key })).status);
    expect(statuses.slice(0, 59).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('keeps humans out of the trade API and limits builds per key', async () => {
    const human = await t.human('did:privy:h', '0x' + '5'.repeat(40));
    expect((await t.call('POST', '/trade/quote', { auth: human, body: {} })).json.error.code).toBe('not_registered');
    const body = { token: TOKEN, side: 'buy', amountIn: '1' };
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await t.call('POST', '/trade/build', { auth: apiKey, body })).status);
    expect(statuses).toContain(429);
  });

  it('is off without the sign-up flag', async () => {
    const { v1 } = await import('../src/agents/app');
    const res = await v1.request('/auth/nonce?address=0x' + '1'.repeat(40), {}, { ...t.env, AGENT_SIGNUP_ENABLED: '' });
    expect(res.status).toBe(404);
  });
});

describe.skipIf(!pg)('key guard allowlist', () => {
  it('lets txHash through on POST /trades only', async () => {
    const t = await setup('guard');
    try {
      const hash = generatePrivateKey();
      // No /trades route here (Data mounts it): passing the guard means a 404, failing it means never_send_keys.
      expect((await t.call('POST', '/trades', { body: { txHash: hash } })).json.error.code).toBe('not_found');
      expect((await t.call('POST', '/trades', { body: { txHash: hash, privateKey: hash } })).json.error.code).toBe('never_send_keys');
      expect((await t.call('POST', '/feedback', { body: { message: 'hi', txHash: hash } })).json.error.code).toBe('never_send_keys');
    } finally {
      await t.teardown();
    }
  });
});

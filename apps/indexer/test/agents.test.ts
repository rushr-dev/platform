import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { pgAvailable, setup } from './harness';

// No RPC in tests: the trade package is replaced with a recorder.
const calls: any[] = [];
vi.mock('@rushr/trade/agent', () => ({
  prepareSwap: async (_client: unknown, req: any, opts: any) => {
    calls.push({ req, opts });
    return {
      quote: { amountIn: req.amountIn, amountOut: 123n, minAmountOut: 120n, warnings: [] },
      alternatives: [],
      tx: { chainId: 4663, to: '0x00000000000000000000000000000000000000ff', data: '0xabcdef', value: req.side === 'buy' ? req.amountIn : 0n },
      approvals: [],
      commands: [],
      deadline: 1700000000n,
      record: {},
      warnings: [],
    };
  },
  toJsonSafe: (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))),
}));

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

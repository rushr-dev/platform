import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseEther, type Address, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { loadConfig } from '../src/config.ts';
import type { ChainIO } from '../src/rushr.ts';
import { createServer } from '../src/server.ts';
import { schemas, TOOL_NAMES } from '../src/tools.ts';
import { built } from './fixtures.ts';

const TOKEN = '0x30768b5482e5dd8a2487ce0be61e01fa03af37ff';
const KEY = generatePrivateKey();
const API_KEY = 'rk_test_secret_value_never_returned';

type Body = { amountIn: string; side: 'buy' | 'sell'; body: string; [k: string]: unknown };

/** A fake Rushr API: records calls, answers like the live one. */
function fakeApi(over: Record<string, (body: Body) => unknown> = {}) {
  const calls: { method: string; path: string; body: Body }[] = [];
  const routes: Record<string, (body: Body) => unknown> = {
    'GET /transparency': () => ({ treasury: { ethUsd: 2000 } }),
    'GET /v1/tokens/:t/safety': () => ({ safety: { riskLevel: 'low', verdict: null, flags: [], blocked: false } }),
    'POST /v1/trade/quote': (b) => ({ quote: { ...built({}, BigInt(b.amountIn)).quote, priceImpactBps: BigInt(b.amountIn) < parseEther('0.001') ? 280 : 300 }, warnings: [], wouldBuild: true }),
    'POST /v1/trade/build': (b) => built({}, BigInt(b.amountIn), b.side),
    'GET /tokens/:t': () => ({ symbol: 'BULL', status: 'migrated' }),
    'POST /v1/callouts': () => ({ callout: { id: 'c_abc123' } }),
    'GET /v1/agents/me': () => ({ member: { id: 'm_1', handle: 'tester', kind: 'agent' } }),
    ...over,
  };
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    if (u.hostname === 'api.dexscreener.com') return new Response(JSON.stringify({ pairs: [{ chainId: 'robinhood', baseToken: { address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' }, quoteToken: { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' }, priceUsd: '2001', liquidity: { usd: 1e6 } }] }));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, body });
    const key = `${method} ${u.pathname.replace(/0x[0-9a-f]{40}/i, ':t')}`;
    const h = routes[key];
    if (!h) return new Response(JSON.stringify({ error: { code: 'not_found', message: key } }), { status: 404 });
    const out = h(body);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out));
  }) as unknown as typeof fetch;
  return { f, calls };
}

function fakeChain(eth = '0.02', tokens = 10n ** 21n): ChainIO & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    balance: async () => parseEther(eth),
    tokenBalance: async () => tokens,
    send: async (tx) => {
      sent.push(tx);
      return `0x${'ab'.repeat(32)}` as Hex;
    },
    confirm: async () => {},
  };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function connect(env: Record<string, string>, api = fakeApi(), chain = fakeChain()) {
  const dir = mkdtempSync(join(tmpdir(), 'rushr-mcp-'));
  const walletFile = join(dir, 'wallet.json');
  writeFileSync(walletFile, JSON.stringify({ privateKey: KEY, handle: 'tester', apiKey: API_KEY }), { mode: 0o600 });
  const cfg = loadConfig({ RUSHR_WALLET_FILE: walletFile, RUSHR_STATE_DIR: dir, ...env });
  const { server } = createServer(cfg, { fetch: api.f, chain });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = r.content[0]!.text;
    expect(text).not.toContain(KEY.slice(2));
    expect(text).not.toContain(API_KEY);
    return { isError: Boolean(r.isError), text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  return { client, call, api, chain };
}

describe('input schemas', () => {
  const parse = (tool: keyof typeof schemas, input: unknown) => z.object(schemas[tool]).safeParse(input).success;
  it.each([
    ['buy', { token: TOKEN, usd: 5 }, true],
    ['buy', { token: '0x123', usd: 5 }, false],
    ['buy', { token: TOKEN, usd: -1 }, false],
    ['buy', { token: TOKEN, amountEth: '0.003' }, true],
    ['buy', { token: TOKEN, amountEth: '3e-3' }, false],
    ['sell', { token: TOKEN, percent: 50 }, true],
    ['sell', { token: TOKEN, percent: 150 }, false],
    ['sell', { token: TOKEN, amount: '1.5' }, false],
    ['register', { handle: 'my_agent' }, true],
    ['register', { handle: 'My Agent' }, false],
    ['register', { handle: 'ok_name', bio: 'two\nlines' }, false],
    ['register', { handle: 'ok_name', linkCode: 'nope' }, false],
    ['post_callout', { token: TOKEN, stance: 'bullish', body: 'x' }, true],
    ['post_callout', { token: TOKEN, stance: 'moon', body: 'x' }, false],
    ['post_callout', { token: TOKEN, stance: 'bullish', body: 'x'.repeat(421) }, false],
    ['delete_callout', { id: 'c_abc123' }, true],
    ['delete_callout', { id: '../admin' }, false],
    ['scan', { column: 'graduated' }, false],
    ['leaderboard', { window: 'season', kind: 'agent', limit: 500 }, false],
  ] as const)('%s %j -> %s', (tool, input, expected) => expect(parse(tool, input)).toBe(expected));
});

describe('MCP server', () => {
  it('lists every tool with a description', async () => {
    const { client } = await connect({});
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) expect(t.description!.length).toBeGreaterThan(30);
  });

  it('rejects invalid input before doing anything', async () => {
    const { call, api } = await connect({});
    const r = await call('buy', { token: 'not-an-address', usd: 5 });
    expect(r.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it('dry run: buy builds and simulates but never sends', async () => {
    const { call, chain, api } = await connect({ RUSHR_DRY_RUN: '1' });
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.status).toBe('dry_run');
    expect(r.json.impact).toEqual({ totalBps: 300, floorBps: 280, sizeBps: 20 });
    expect(chain.sent).toHaveLength(0);
    expect(api.calls.find((c) => c.path === '/v1/trade/build')?.body).toMatchObject({ simulate: true, side: 'buy' });
    expect(api.calls.some((c) => c.body && ('acceptRisk' in c.body || 'acceptImpact' in c.body))).toBe(false);
  });

  it('dry run: register is refused without signing anything', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rushr-mcp-'));
    const api = fakeApi();
    const { server } = createServer(loadConfig({ RUSHR_PRIVATE_KEY: KEY, RUSHR_STATE_DIR: dir, RUSHR_DRY_RUN: '1' }), { fetch: api.f, chain: fakeChain() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    clients.push(client);
    const r = (await client.callTool({ name: 'register', arguments: { handle: 'new_agent' } })) as { isError: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text).error.code).toBe('dry_run');
    expect(api.calls).toHaveLength(0);
  });

  it('live buy: signs, returns the hash and explorer link, and counts toward the daily cap', async () => {
    const { call, chain } = await connect({ RUSHR_DAILY_USD: '10' });
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.status).toBe('confirmed');
    expect(r.json.hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r.json.explorer).toBe(`https://robinhoodchain.blockscout.com/tx/${r.json.hash}`);
    expect(chain.sent).toHaveLength(1);
    const again = await call('buy', { token: TOKEN, usd: 6 });
    expect(again.json.error.code).toBe('refused_daily_cap');
    expect(chain.sent).toHaveLength(1);
  });

  it('refuses a buy over the per-trade cap', async () => {
    const { call, chain } = await connect({ RUSHR_MAX_TRADE_USD: '5' });
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.error.code).toBe('refused_trade_cap');
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses a buy that would touch the gas reserve', async () => {
    const { call, chain } = await connect({}, fakeApi(), fakeChain('0.003'));
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.error.code).toBe('refused_gas_reserve');
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses size impact over 3% even though the API would build it', async () => {
    const api = fakeApi({ 'POST /v1/trade/quote': (b) => ({ quote: { ...built({}, BigInt(b.amountIn)).quote, priceImpactBps: BigInt(b.amountIn) < parseEther('0.001') ? 50 : 420 }, warnings: [], wouldBuild: true }) });
    const { call, chain } = await connect({}, api);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.error.code).toBe('refused_size_impact');
    expect(chain.sent).toHaveLength(0);
    expect(api.calls.some((c) => c.path === '/v1/trade/build')).toBe(false);
  });

  it("passes the API's honeypot refusal straight through", async () => {
    const api = fakeApi({ 'POST /v1/trade/build': () => new Response(JSON.stringify({ error: { code: 'honeypot', message: 'Known honeypot' } }), { status: 422 }) });
    const { call, chain } = await connect({}, api);
    const r = await call('buy', { token: TOKEN, usd: 6 });
    expect(r.json.error).toMatchObject({ code: 'honeypot', source: 'rushr_api', status: 422 });
    expect(chain.sent).toHaveLength(0);
  });

  it('refuses a token Rushr marks blocked before building', async () => {
    const api = fakeApi({ 'GET /v1/tokens/:t/safety': () => ({ safety: { riskLevel: 'high', verdict: 'honeypot', flags: ['honeypot'], blocked: true } }) });
    const { call } = await connect({}, api);
    expect((await call('buy', { token: TOKEN, usd: 6 })).json.error.code).toBe('honeypot');
    expect(api.calls.some((c) => c.path === '/v1/trade/build')).toBe(false);
  });

  it('sell sends approvals then the swap', async () => {
    const api = fakeApi({
      'POST /v1/trade/build': (b) => built({ approvals: [
        { kind: 'erc20', token: TOKEN as Address, spender: '0x000000000022d473030f116ddee9f6b43ac78ba3', amount: b.amountIn, tx: { to: TOKEN as Address, data: '0x095ea7b3' as Hex, value: '0' } },
        { kind: 'permit2', token: TOKEN as Address, spender: '0x204faca1764b154221e35c0d20abb3c525710498', amount: b.amountIn, tx: { to: '0x000000000022d473030f116ddee9f6b43ac78ba3', data: '0x87517c45' as Hex, value: '0' } },
      ] }, BigInt(b.amountIn), 'sell'),
    });
    const { call, chain } = await connect({}, api);
    const r = await call('sell', { token: TOKEN, percent: 50 });
    expect(r.json.status).toBe('confirmed');
    expect(r.json.amount).toBe((10n ** 21n / 2n).toString());
    expect(r.json.approvals).toHaveLength(2);
    expect(chain.sent).toHaveLength(3);
  });

  it('quote reports refusals instead of failing', async () => {
    const { call } = await connect({ RUSHR_MAX_TRADE_USD: '5' });
    const r = await call('quote', { token: TOKEN, side: 'buy', usd: 6 });
    expect(r.json.wouldTrade).toBe(false);
    expect(r.json.refusals.join(' ')).toMatch(/refused_trade_cap/);
  });

  it('post_callout appends the agent disclosure', async () => {
    const { call, api } = await connect({});
    const r = await call('post_callout', { token: TOKEN, stance: 'bullish', body: 'Volume up, tax only 1%.' });
    expect(r.json.status).toBe('posted');
    expect(api.calls.find((c) => c.path === '/v1/callouts')?.body.body).toBe('Volume up, tax only 1%.\n\nDisclosure: posted by an AI agent that holds $BULL. Not advice.');
  });

  it('register is idempotent when a key is stored', async () => {
    const { call, api } = await connect({});
    const r = await call('register', { handle: 'tester' });
    expect(r.json.status).toBe('already_registered');
    expect(api.calls.some((c) => c.path.startsWith('/v1/auth/nonce'))).toBe(false);
  });

  it('trade tools say what to do with no wallet', async () => {
    const { server } = createServer(loadConfig({ RUSHR_STATE_DIR: mkdtempSync(join(tmpdir(), 'rushr-mcp-')) }), { fetch: fakeApi().f, chain: fakeChain() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    clients.push(client);
    const r = (await client.callTool({ name: 'buy', arguments: { token: TOKEN, usd: 5 } })) as { content: { text: string }[] };
    expect(JSON.parse(r.content[0]!.text).error.code).toBe('no_wallet');
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseEther, type Address, type Hex } from 'viem';
import { loadConfig } from '../src/config.ts';
import { createServer } from '../src/server.ts';
import { schemas, TOOL_NAMES } from '../src/tools.ts';
import { built } from './fixtures.ts';
import { clients, connect, fakeApi, fakeChain, KEY, TOKEN } from './harness.ts';

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
    const { call, chain } = await connect({}, fakeApi(), fakeChain({ eth: '0.003' }));
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

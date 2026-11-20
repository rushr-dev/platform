import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, expect } from 'vitest';
import { parseEther, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { loadConfig } from '../src/config.ts';
import type { ChainIO, SendTx } from '../src/rushr.ts';
import { createServer } from '../src/server.ts';
import { built } from './fixtures.ts';

export const TOKEN = '0x30768b5482e5dd8a2487ce0be61e01fa03af37ff';
export const KEY = generatePrivateKey();
export const API_KEY = 'rk_test_secret_value_never_returned';

export type Body = { amountIn: string; side: 'buy' | 'sell'; body: string; txHash: string; [k: string]: unknown };
export type Route = (body: Body, n: number) => unknown;

/** A fake Rushr API: records calls, answers like the live one. `n` counts calls to that route (1-based). */
export function fakeApi(over: Record<string, Route> = {}) {
  const calls: { method: string; path: string; body: Body }[] = [];
  const counts: Record<string, number> = {};
  const routes: Record<string, Route> = {
    'GET /transparency': () => ({ treasury: { ethUsd: 2000 } }),
    'GET /v1/tokens/:t/safety': () => ({ safety: { riskLevel: 'low', verdict: null, flags: [], blocked: false } }),
    'POST /v1/trade/quote': (b) => ({ quote: { ...built({}, BigInt(b.amountIn)).quote, priceImpactBps: BigInt(b.amountIn) < parseEther('0.001') ? 280 : 300 }, warnings: [], wouldBuild: true }),
    'POST /v1/trade/build': (b) => built({}, BigInt(b.amountIn), b.side),
    'GET /tokens/:t': () => ({ symbol: 'BULL', status: 'migrated' }),
    'POST /v1/callouts': () => ({ callout: { id: 'c_abc123' } }),
    'GET /v1/agents/me': () => ({ member: { id: 'm_1', handle: 'tester', kind: 'agent' } }),
    'POST /v1/agents/me/fees': () => new Response(JSON.stringify({ ok: true }), { status: 201 }),
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
    counts[key] = (counts[key] ?? 0) + 1;
    const out = h(body, counts[key]!);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out));
  }) as unknown as typeof fetch;
  return { f, calls };
}

export const apiError = (status: number, code: string, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ error: { code, message: code, ...extra } }), { status });

export interface FakeChain extends ChainIO {
  sent: SendTx[];
  /** Every send and confirm, in order, as "send:<to>" / "confirm:<hash>". */
  log: string[];
}

/**
 * A fake chain. `failSends` makes the first n sends to `failTo` throw (a network error), `curve` is what
 * PONS's factory returns for any token. `tokenBalance` answers balanceOf from the sends so far.
 */
export function fakeChain(opts: { eth?: string; tokens?: bigint; tokenBalance?: (token: string, log: readonly string[]) => bigint; curve?: string | null; failSends?: number; failTo?: string; failMessage?: string } = {}): FakeChain {
  const sent: SendTx[] = [];
  const log: string[] = [];
  let fails = opts.failSends ?? 0;
  let n = 0;
  return {
    sent,
    log,
    balance: async () => parseEther(opts.eth ?? '0.02'),
    tokenBalance: async (token) => (opts.tokenBalance ? opts.tokenBalance(token.toLowerCase(), log) : (opts.tokens ?? 10n ** 21n)),
    ponsCurve: async () => (opts.curve === undefined ? null : (opts.curve as Hex | null)),
    nonce: async () => 7,
    send: async (tx) => {
      log.push(`send:${tx.to.toLowerCase()}`);
      if (fails > 0 && (!opts.failTo || tx.to.toLowerCase() === opts.failTo.toLowerCase())) {
        fails--;
        throw new Error(opts.failMessage ?? 'fetch failed');
      }
      sent.push(tx);
      n++;
      return `0x${n.toString(16).padStart(64, '0')}` as Hex;
    },
    confirm: async (h) => {
      log.push(`confirm:${h}`);
    },
  };
}

const clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

export async function connect(env: Record<string, string>, api = fakeApi(), chain: FakeChain = fakeChain()) {
  const dir = mkdtempSync(join(tmpdir(), 'rushr-mcp-'));
  const walletFile = join(dir, 'wallet.json');
  writeFileSync(walletFile, JSON.stringify({ privateKey: KEY, handle: 'tester', apiKey: API_KEY }), { mode: 0o600 });
  const cfg = loadConfig({ RUSHR_WALLET_FILE: walletFile, RUSHR_STATE_DIR: dir, ...env });
  const { server, wallet } = createServer(cfg, { fetch: api.f, chain, sleep: async () => {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  clients.push(client);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = r.content[0]!.text;
    expect(text).not.toContain(KEY.slice(2));
    expect(text).not.toContain(API_KEY);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool results are free-form JSON in tests
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { isError: Boolean(r.isError), text, json };
  };
  return { client, call, api, chain, address: wallet!.address, track: (c: Client) => clients.push(c) };
}

export { clients };

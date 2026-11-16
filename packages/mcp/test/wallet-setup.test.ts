import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createServer } from '../src/server.ts';
import { fakeApi, fakeChain } from './harness.ts';

const opened: Client[] = [];
afterAll(async () => {
  await Promise.all(opened.map((c) => c.close()));
});

async function plugin(dir: string) {
  const cfg = loadConfig({ RUSHR_STATE_DIR: dir });
  const { server, wallet } = createServer(cfg, { fetch: fakeApi().f, chain: fakeChain(), sleep: async () => {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  opened.push(client);
  const call = async (name: string) => {
    const r = (await client.callTool({ name, arguments: {} })) as { isError?: boolean; content: { text: string }[] };
    return { isError: Boolean(r.isError), json: JSON.parse(r.content[0]!.text) };
  };
  return { call, wallet, cfg };
}

describe('plugin setup: create_wallet and the default keyfile', () => {
  it('with no wallet configured, create_wallet writes ~/.rushr/agent-wallet.json (mode 600) and returns only the address', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rushr-plugin-'));
    const { call, wallet } = await plugin(dir);
    expect(wallet).toBeNull();
    const r = await call('create_wallet');
    expect(r.isError).toBe(false);
    const path = join(dir, 'agent-wallet.json');
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const file = JSON.parse(readFileSync(path, 'utf8'));
    expect(r.json.address).toBe(file.address);
    expect(JSON.stringify(r.json)).not.toContain(file.privateKey.slice(2));
  });

  it('a restarted server loads that keyfile by default, and create_wallet then refuses', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rushr-plugin-'));
    const first = await plugin(dir);
    const created = await first.call('create_wallet');
    const second = await plugin(dir);
    expect(second.cfg.walletFile).toBe(join(dir, 'agent-wallet.json'));
    expect(second.wallet?.address).toBe(created.json.address);
    const again = await second.call('create_wallet');
    expect(again.isError).toBe(true);
    expect(again.json.error.code).toBe('wallet_exists');
  });

  it('never overwrites an existing keyfile', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rushr-plugin-'));
    const a = await plugin(dir);
    const b = await plugin(dir);
    await a.call('create_wallet');
    const before = readFileSync(join(dir, 'agent-wallet.json'), 'utf8');
    const r = await b.call('create_wallet');
    expect(r.isError).toBe(true);
    expect(r.json.error.code).toBe('wallet_file_exists');
    expect(readFileSync(join(dir, 'agent-wallet.json'), 'utf8')).toBe(before);
  });

  it('an explicit RUSHR_WALLET_FILE or RUSHR_PRIVATE_KEY still wins over the default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rushr-plugin-'));
    expect(loadConfig({ RUSHR_STATE_DIR: dir, RUSHR_WALLET_FILE: '/x/w.json' }).walletFile).toBe('/x/w.json');
    expect(loadConfig({ RUSHR_STATE_DIR: dir }).walletFile).toBeUndefined();
  });
});

// The off switch (src/pause.ts): the flag itself, and that paused code paths don't reach the chain.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Durable Object base class for Node: just keeps ctx and env, like the runtime's.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import type { Sql } from 'postgres';
import { freshDb, pgAvailable } from '../../../packages/agents/test/pg';
import { parsePause, readPause, resetPauseCache, writePause, PAUSED_REQUEUE_S } from '../src/pause';
import { ChainPoller } from '../src/poller';
import { api } from '../src/api';
import worker from '../src/index';

describe('parsePause', () => {
  it('reads a missing or odd row as running', () => {
    expect(parsePause(undefined).paused).toBe(false);
    expect(parsePause('yes').paused).toBe(false);
    expect(parsePause({ paused: 'true' }).paused).toBe(false);
  });
  it('keeps pausedAt only while paused', () => {
    expect(parsePause({ paused: true, pausedAt: '2026-11-14T00:00:00Z', reason: 'rpc' })).toEqual({
      paused: true, pausedAt: '2026-11-14T00:00:00Z', resumedAt: null, reason: 'rpc',
    });
    expect(parsePause({ paused: false, pausedAt: 'x', resumedAt: 'y' })).toMatchObject({ paused: false, pausedAt: null, resumedAt: 'y' });
  });
});

/** In-memory Durable Object storage with one alarm. */
function memoryStorage() {
  const data = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    data,
    async get<T>(k: string) { return data.get(k) as T | undefined; },
    async put(k: string, v: unknown) { data.set(k, v); },
    async delete(k: string) { data.delete(k); },
    async getAlarm() { return alarm; },
    async setAlarm(t: number) { alarm = t; },
    async deleteAlarm() { alarm = null; },
  };
}

describe('ChainPoller pause', () => {
  it('stays stopped through the cron start() until resume()', async () => {
    const storage = memoryStorage();
    const poller = new ChainPoller({ storage } as never, {} as never);
    await poller.start();
    expect(await storage.getAlarm()).not.toBeNull();
    await poller.pause();
    expect(await storage.getAlarm()).toBeNull();
    await poller.start(); // what scheduled() does every minute
    expect(await storage.getAlarm()).toBeNull();
    // An alarm that was already in flight returns before touching the chain or the database.
    await poller.alarm();
    expect(await storage.getAlarm()).toBeNull();
    await poller.resume();
    expect(await storage.getAlarm()).not.toBeNull();
    expect(storage.data.get('paused')).toBeUndefined();
  });
});

const ok = await pgAvailable();
describe.skipIf(!ok)('paused indexer (local Postgres)', () => {
  let db: { url: string; sql: Sql; drop: () => Promise<void> };
  const never = (what: string) => () => {
    throw new Error(`${what} touched while paused`);
  };
  let hydrations = 0;
  const env = () => ({
    DATABASE_URL: db.url,
    RPC_URL: 'http://rpc.invalid',
    HYDRATOR: { idFromName: (n: string) => n, get: () => ({ hydrate: async () => (hydrations++, { state: 'hydrating' }) }) },
    CHAIN_POLLER: { idFromName: never('poller'), get: never('poller') },
  });
  const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} };
  const unknown = '0x' + 'ab'.repeat(20);

  beforeAll(async () => {
    db = await freshDb('pause');
  });
  afterAll(async () => {
    await db?.drop();
  });
  beforeEach(() => {
    resetPauseCache();
    hydrations = 0;
  });

  it('stores the flag; a second pause keeps the first pausedAt; resume records resumedAt', async () => {
    const a = await writePause(db.sql, true, 'rpc spend');
    expect(a).toMatchObject({ paused: true, reason: 'rpc spend' });
    const b = await writePause(db.sql, true, null);
    expect(b.pausedAt).toBe(a.pausedAt);
    const c = await writePause(db.sql, false);
    expect(c).toMatchObject({ paused: false, pausedAt: null });
    expect(c.resumedAt).not.toBeNull();
    resetPauseCache();
    expect(await readPause(db.sql)).toEqual(c);
  });

  it('answers 503 paused for an unindexed token without waking its hydrator', async () => {
    await writePause(db.sql, true);
    const res = await api.request(`/tokens/${unknown}`, {}, env(), ctx);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'paused' } });
    expect(hydrations).toBe(0);

    await writePause(db.sql, false);
    const live = await api.request(`/tokens/${unknown}`, {}, env(), ctx);
    expect(live.status).toBe(202);
    expect(hydrations).toBe(1);
  });

  it('keeps DB reads working while paused', async () => {
    await writePause(db.sql, true);
    const res = await api.request('/stats', {}, env(), ctx);
    expect(res.status).toBe(200);
  });

  it('scheduled() does nothing while paused (no poller start)', async () => {
    await writePause(db.sql, true);
    await expect(worker.scheduled!({ scheduledTime: Date.now(), cron: '* * * * *' } as never, env() as never, ctx as never)).resolves.toBeUndefined();
  });

  it('queue consumers put messages back for later instead of calling RPC', async () => {
    await writePause(db.sql, true);
    const sent: { body: unknown; delaySeconds?: number }[][] = [];
    const queue = { sendBatch: async (m: { body: unknown; delaySeconds?: number }[]) => void sent.push(m), send: never('send') };
    let acked = false;
    const batch = {
      queue: 'rushr-enrich',
      messages: [
        { body: { kind: 'token-signals', token: unknown }, ack: never('ack'), retry: never('retry') },
        { body: { kind: 'trade-confirm', tx: '0x' + '1'.repeat(64) }, ack: never('ack'), retry: never('retry') },
      ],
      ackAll: () => void (acked = true),
      retryAll: never('retryAll'),
    };
    await worker.queue!(batch as never, { ...env(), ENRICH_QUEUE: queue, METADATA_QUEUE: { sendBatch: never('metadata queue') } } as never, ctx as never);
    expect(acked).toBe(true);
    expect(sent.flat()).toEqual(batch.messages.map((m) => ({ body: m.body, delaySeconds: PAUSED_REQUEUE_S })));
  });
});

import { DurableObject } from 'cloudflare:workers';
import postgres, { type Sql } from 'postgres';
import { PAIR_SWAP_TOPICS, ROBINHOOD_CHAIN, tradeTopics, type RawLog } from '@rushr/core';
import { dbUrl, poolHistory, type Env } from './env';
import { Pipeline, type BatchStats, type RangeStats } from './pipeline';
import { tokenSummaries } from './api';
import type { FeedEvent } from './feed';
import { Rpc } from './rpc';

/** ~55s of blocks per getLogs call at 0.11s blocks. */
const RANGE = 500n;
/** Stop a catch-up loop after this long and reschedule, to stay well within alarm limits. */
const BUDGET_MS = 20_000;
/** A poll step that takes longer than this is treated as hung (see resetDb). */
const STEP_TIMEOUT_MS = 90_000;

class StepTimeout extends Error {
  override name = 'StepTimeout';
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(`${what} took over ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => timer !== undefined && clearTimeout(timer));
}
/** Live logs are written in small batches this often. */
const FLUSH_MS = 200;
/** Once caught up, polling only confirms what the live path already wrote. */
const POLL_MS = 2_000;
/** Most v3/v2 pool addresses on the live pair-swap subscription. */
const PAIR_SUB_MAX = 500;
/** Recompute a token's signals at most this often while it's trading. */
const SIGNAL_DEBOUNCE_MS = 15_000;

interface LiveStats {
  connected: boolean;
  logs: number;
  batches: number;
  swaps: number;
  launches: number;
  /** Block time → written to Postgres, for the last batch. */
  lastLatencyMs: number | null;
  reconnects: number;
}

/**
 * Single instance ("main") that follows Robinhood Chain.
 *
 * Live path: an eth_subscribe("logs") WebSocket pushes trades, launches and migrations as blocks
 * land; they are written every ~200ms. Polling path: alarms read confirmed block ranges with
 * eth_getLogs from the cursor (every event, Transfers included), backfilling anything the socket
 * missed. Writes are idempotent, so the two paths can overlap.
 *
 * Why Transfers aren't on the socket: Alchemy bills subscriptions per byte delivered, and Transfers
 * for every token on the chain are ~80% of the volume. getLogs costs the same per call however much
 * it returns, so holders and balances come from polling at a fraction of the cost (~2-4s behind).
 */
export class ChainPoller extends DurableObject<Env> {
  private sql?: Sql;
  private pipeline?: Pipeline;
  /** Separate pipeline + queue for the live path, so a slow catch-up range never delays live trades. */
  private livePipeline?: Pipeline;
  private liveQueue: Promise<unknown> = Promise.resolve();
  private last?: Pick<RangeStats, 'logs' | 'launches' | 'swaps' | 'transfers' | 'ms'> & {
    from: string;
    to: string;
    head: string;
    lag: number;
  };

  private ws?: WebSocket;
  private buffer: RawLog[] = [];
  private flushTimer?: ReturnType<typeof setTimeout>;
  private live: LiveStats = { connected: false, logs: 0, batches: 0, swaps: 0, launches: 0, lastLatencyMs: null, reconnects: 0 };
  private queue: Promise<unknown> = Promise.resolve();
  private signalQueuedAt = new Map<string, number>();
  /**
   * Address-filtered subscription for v3/v2 swaps of tracked pools (LIVE_PAIRS=1). `key` is the
   * address set it covers; a new set is subscribed first and the old one dropped once confirmed
   * (same socket, no gap, no reconnect).
   */
  private pairSub: { id: string | null; key: string; pools: number; checkedAt: number; changedAt: number } = { id: null, key: '', pools: 0, checkedAt: 0, changedAt: 0 };
  private pairPending?: { reqId: number; key: string; pools: number };
  private nextReqId = 100;
  private pairsDirty = true;
  /** Socket bytes received per subscription, for checking the Alchemy bandwidth estimate. */
  private meter = { since: Date.now(), main: 0, pair: 0, other: 0, prev: null as null | { minutes: number; mainPerMin: number; pairPerMin: number } };

  private init() {
    if (!this.pipeline) {
      // This object lives for hours, but Hyperdrive can drop idle connections without the client noticing
      // (the next query on that socket then never returns). Keep connections short-lived.
      // Workers allow 6 simultaneous outgoing connections per invocation: 3 for Postgres leaves room
      // for the Alchemy socket and RPC fetches (more than 6 deadlocks: new sockets wait forever).
      this.sql = postgres(dbUrl(this.env), {
        max: 3,
        fetch_types: false,
        prepare: false,
        idle_timeout: 15,
        max_lifetime: 300,
        connect_timeout: 10,
      });
      this.pipeline = new Pipeline(this.sql, new Rpc(this.env.RPC_URL));
      this.livePipeline = new Pipeline(this.sql, new Rpc(this.env.RPC_URL));
    }
    return this.pipeline;
  }

  /**
   * Live flushes run one at a time on their own lane. Writes are idempotent (keyed by tx/log index,
   * balances and candles only applied for newly inserted rows), so the two lanes can overlap safely.
   */
  private liveSerial<T>(fn: (p: Pipeline) => Promise<T>): Promise<T> {
    this.init();
    const next = this.liveQueue.then(() => fn(this.livePipeline!));
    this.liveQueue = next.catch(() => undefined);
    return next;
  }

  /** Run pipeline work one job at a time (live flushes and polling ranges share in-memory state). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async start(): Promise<void> {
    await this.ctx.storage.put('enabled', true);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 100);
  }

  async stop(): Promise<void> {
    await this.ctx.storage.put('enabled', false);
    await this.ctx.storage.deleteAlarm();
    this.ws?.close(1000, 'stopped');
    this.ws = undefined;
    this.live.connected = false;
  }

  /** Dev: index launch windows for tokens discovered mid-life, then queue their signals. */
  async backfillLaunches(): Promise<number> {
    const pipeline = this.init();
    const tokens = await this.serial(() => pipeline.backfillMissingLaunches());
    for (const t of tokens) this.signalQueuedAt.delete(t);
    await this.queueSignals(tokens);
    return tokens.length;
  }

  async status() {
    const pipeline = this.init();
    const cursor = await pipeline.cursor();
    return {
      cursor: cursor?.toString() ?? null,
      running: (await this.ctx.storage.getAlarm()) !== null,
      live: {
        ...this.live,
        pairPools: this.env.LIVE_PAIRS === '1' ? this.pairSub.pools : null,
        socketBytes: this.meterStats(),
      },
      last: this.last ?? null,
      attempt: (await this.ctx.storage.get('attempt')) ?? null,
      stage: (await this.ctx.storage.get('stage')) ?? null,
      alarmAt: await this.ctx.storage.getAlarm(),
      lastError: (await this.ctx.storage.get('lastError')) ?? null,
    };
  }

  /** Where the alarm loop is, for /health (a hang shows up as a stage that stops changing). */
  private async stage(name: string) {
    await this.ctx.storage.put('stage', { name, at: new Date().toISOString() });
  }

  override async alarm(): Promise<void> {
    await this.stage('alarm');
    if (!(await this.ctx.storage.get<boolean>('enabled'))) return;
    const pipeline = this.init();
    await this.openSocket();
    await this.stage('socket');
    const rpc = new Rpc(this.env.RPC_URL);
    const started = Date.now();
    let caughtUp = false;
    try {
      const head = (await rpc.blockNumber()) - BigInt(ROBINHOOD_CHAIN.confirmations);
      await this.stage('head');
      let cursor: bigint = (await pipeline.cursor()) ?? head - BigInt(this.env.START_BLOCKS_BACK ?? '33000');
      // A range that never finished (the isolate was killed mid-step, e.g. on a huge airdrop) is retried
      // at half the size, so one heavy range can't stall indexing.
      // The range then grows back (doubling per finished step) once the busy stretch is behind us.
      const unfinished = await this.ctx.storage.get<{ from: string; range: string }>('attempt');
      let range =
        unfinished && BigInt(unfinished.from) === cursor + 1n
          ? BigInt(unfinished.range) / 2n || 1n
          : BigInt((await this.ctx.storage.get<string>('range')) ?? RANGE.toString());
      if (unfinished) console.warn(`poller: retrying ${cursor + 1n} with a ${range}-block range`);
      while (Date.now() - started < BUDGET_MS) {
        if (cursor >= head) {
          caughtUp = true;
          break;
        }
        const from = cursor + 1n;
        const to: bigint = cursor + range > head ? head : cursor + range;
        await this.ctx.storage.put('attempt', { from: from.toString(), range: range.toString() });
        await this.stage(`step ${from}-${to}`);
        const stats = await withTimeout(this.serial(() => pipeline.run(from, to)), STEP_TIMEOUT_MS, `poll ${from}-${to}`);
        range = range * 2n > RANGE ? RANGE : range * 2n;
        await this.ctx.storage.put('range', range.toString());
        await this.ctx.storage.delete('attempt');
        cursor = to;
        await this.queueSignals([...stats.newTokens, ...stats.touched]);
        await this.queueMetadata(stats.newTokens);
        await this.handOffPools(pipeline);
        await this.publish(stats, 'poll');
        this.last = {
          logs: stats.logs, launches: stats.launches, swaps: stats.swaps, transfers: stats.transfers, ms: stats.ms,
          from: from.toString(), to: to.toString(), head: head.toString(), lag: Number(head - cursor),
        };
        if (stats.swaps || stats.launches) {
          console.log(
            `poll ${from}-${to}: backfilled ${stats.launches} launches, ${stats.swaps} swaps, ${stats.transfers} transfers (${stats.ms}ms, lag ${this.last.lag})`,
          );
        }
      }
    } catch (err) {
      console.error('poller error', err);
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      await this.ctx.storage.put('lastError', { at: new Date().toISOString(), message: message.slice(0, 500) });
      if (err instanceof StepTimeout) await this.resetDb();
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + (caughtUp ? POLL_MS : 10));
  }

  /** Drop every connection and start over (after a hung step). In-flight work on the old pool is abandoned. */
  private async resetDb() {
    const old = this.sql;
    this.sql = undefined;
    this.pipeline = undefined;
    this.livePipeline = undefined;
    this.queue = Promise.resolve();
    this.liveQueue = Promise.resolve();
    await old?.end({ timeout: 0 }).catch(() => undefined);
  }

  /** Pools discovery just added: replay their recent swaps (pool-history backfill), and stream them live. */
  private async handOffPools(p: Pipeline) {
    const ids = p.takeDiscoveredPools();
    if (!ids.length) return;
    this.pairsDirty = true;
    try {
      await poolHistory(this.env).enqueuePools(ids);
    } catch (err) {
      console.error('pool history enqueue failed', err);
    }
  }

  /**
   * Keep the pair-swap subscription in step with the v3/v2 pools worth streaming: the pools of the
   * tracked tokens with the most 24h volume, capped at PAIR_SUB_MAX addresses (the rest arrive via
   * polling, 2-4s later). Re-checked every 60s when discovery added pools, else every 5 min, and only
   * re-subscribed when the address set actually changed.
   */
  private async syncPairSubscription() {
    if (this.env.LIVE_PAIRS !== '1' || !this.ws || !this.live.connected || !this.sql || this.pairPending) return;
    const since = Date.now() - this.pairSub.checkedAt;
    if (since < (this.pairsDirty ? 60_000 : 300_000)) return;
    this.pairSub.checkedAt = Date.now();
    this.pairsDirty = false;
    const rows = await this.sql<{ id: string }[]>`
      select p.id from pools p join tokens t on t.address = p.token
      where p.dex in ('v3', 'v2')
      order by t.volume_24h_usd desc nulls last, p.created_at desc
      limit ${PAIR_SUB_MAX}`;
    const ids = rows.map((r) => r.id).sort();
    const key = ids.join(',');
    if (!ids.length || key === this.pairSub.key) return;
    const reqId = ++this.nextReqId;
    this.pairPending = { reqId, key, pools: ids.length };
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: reqId, method: 'eth_subscribe', params: ['logs', { address: ids, topics: [PAIR_SWAP_TOPICS] }] }));
  }

  private meterStats() {
    const minutes = (Date.now() - this.meter.since) / 60_000;
    const per = (b: number) => (minutes > 0 ? Math.round(b / minutes) : null);
    return {
      minutes: Math.round(minutes * 10) / 10,
      mainPerMin: per(this.meter.main),
      pairPerMin: per(this.meter.pair),
      otherPerMin: per(this.meter.other),
      previousHour: this.meter.prev,
    };
  }

  /** Open (or keep) the eth_subscribe socket. Called on every alarm, so a drop reconnects within ~2s. */
  private async openSocket(): Promise<void> {
    if (this.ws) {
      await this.syncPairSubscription().catch((err) => console.error('pair subscription failed', err));
      return;
    }
    this.pairSub = { id: null, key: '', pools: 0, checkedAt: 0, changedAt: 0 };
    this.pairPending = undefined;
    try {
      const res = await fetch(this.env.RPC_URL, { headers: { Upgrade: 'websocket' } });
      const ws = res.webSocket;
      if (!ws) throw new Error(`no websocket (HTTP ${res.status})`);
      ws.accept();
      this.ws = ws;
      if (this.live.batches) this.live.reconnects++;
      ws.addEventListener('message', (event) => this.onMessage(event.data));
      const drop = () => {
        if (this.ws === ws) this.ws = undefined;
        this.live.connected = false;
      };
      ws.addEventListener('close', drop);
      ws.addEventListener('error', drop);
      ws.send(
        // Trades, launches and migrations only. ERC-20 Transfers (~80% of the chain's logs, and
        // Alchemy bills socket traffic per byte) come from the polling path instead, ~2-4s later.
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['logs', { topics: [tradeTopics()] }] }),
      );
    } catch (err) {
      console.error('websocket connect failed', err);
      this.ws = undefined;
    }
  }

  /** Push new trades and refreshed token cards to browsers via the LiveFeed DO. */
  private async publish(stats: BatchStats, source: 'live' | 'poll') {
    if (!stats.trades.length && !stats.newTokens.length) return;
    try {
      const feed = this.env.LIVE_FEED.get(this.env.LIVE_FEED.idFromName('global'));
      // Trades go out first, straight from the decoded logs, so token pages tick without waiting on a query.
      const byToken = new Map<string, BatchStats['trades']>();
      for (const t of stats.trades) byToken.set(t.token, [...(byToken.get(t.token) ?? []), t]);
      const tradeEvents: FeedEvent[] = [...byToken].map(([token, trades]) => ({ topic: `token:${token}`, type: 'trades', data: trades, source }));
      if (tradeEvents.length) await feed.publish(tradeEvents);

      const events: FeedEvent[] = [];
      const changed = [...new Set([...stats.newTokens, ...byToken.keys()])];
      if (changed.length && this.sql) {
        const cards = await tokenSummaries(this.sql, { addresses: changed });
        const fresh = new Set(stats.newTokens);
        // Block time of the newest log for each token, so clients can show feed latency.
        const seenAt = new Map<string, number>();
        for (const t of stats.trades) seenAt.set(t.token, Math.max(seenAt.get(t.token) ?? 0, t.time));
        for (const card of cards) {
          const data = { ...card, block_time: seenAt.get(card.address as string) ?? null };
          events.push({ topic: 'trenches', type: fresh.has(card.address as string) ? 'launch' : 'token', data, source });
          events.push({ topic: `token:${card.address}`, type: 'token', data, source });
        }
      }
      if (events.length) await feed.publish(events);
    } catch (err) {
      console.error('publish failed', err);
    }
  }

  /** Resolve icon and socials for newly seen tokens (once each; the queue retries failures). */
  private async queueMetadata(tokens: string[]) {
    for (let i = 0; i < tokens.length; i += 100) {
      await this.env.METADATA_QUEUE.sendBatch(tokens.slice(i, i + 100).map((token) => ({ body: { kind: 'token-metadata' as const, token } })));
    }
  }

  /** Ask the enrich queue to recompute signals, debounced per token. */
  private async queueSignals(tokens: string[]) {
    const now = Date.now();
    const due = [...new Set(tokens)].filter((t) => now - (this.signalQueuedAt.get(t) ?? 0) >= SIGNAL_DEBOUNCE_MS);
    if (!due.length) return;
    for (const t of due) this.signalQueuedAt.set(t, now);
    if (this.signalQueuedAt.size > 20_000) {
      for (const [t, at] of this.signalQueuedAt) if (now - at > 10 * 60_000) this.signalQueuedAt.delete(t);
    }
    for (let i = 0; i < due.length; i += 100) {
      await this.env.ENRICH_QUEUE.sendBatch(due.slice(i, i + 100).map((token) => ({ body: { kind: 'token-signals' as const, token } })));
    }
  }

  private onMessage(data: string | ArrayBuffer) {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const msg = JSON.parse(text) as {
      id?: number;
      error?: { message: string };
      result?: string;
      params?: { subscription?: string; result: RawLog };
    };
    // Meter bytes per subscription (Alchemy bills socket traffic per byte); roll the window hourly.
    const bytes = typeof data === 'string' ? text.length : data.byteLength;
    if (msg.params?.subscription && msg.params.subscription === this.pairSub.id) this.meter.pair += bytes;
    else if (msg.params?.subscription) this.meter.main += bytes;
    else this.meter.other += bytes;
    if (Date.now() - this.meter.since > 3_600_000) {
      const s = this.meterStats();
      this.meter = { since: Date.now(), main: 0, pair: 0, other: 0, prev: { minutes: s.minutes, mainPerMin: s.mainPerMin ?? 0, pairPerMin: s.pairPerMin ?? 0 } };
    }
    if (msg.id === 1) {
      if (msg.error) console.error('eth_subscribe failed', msg.error.message);
      else this.live.connected = true;
      return;
    }
    if (this.pairPending && msg.id === this.pairPending.reqId) {
      const pending = this.pairPending;
      this.pairPending = undefined;
      if (msg.error || !msg.result) {
        console.error('pair eth_subscribe failed', msg.error?.message);
        return;
      }
      // New set is live: drop the old one (same socket, so nothing is missed in between).
      const old = this.pairSub.id;
      this.pairSub = { ...this.pairSub, id: msg.result, key: pending.key, pools: pending.pools, changedAt: Date.now() };
      if (old) this.ws?.send(JSON.stringify({ jsonrpc: '2.0', id: ++this.nextReqId, method: 'eth_unsubscribe', params: [old] }));
      return;
    }
    if (msg.id !== undefined) return; // unsubscribe acks
    if (!msg.params?.result) return;
    this.buffer.push(msg.params.result);
    this.flushTimer ??= setTimeout(() => void this.flush(), FLUSH_MS);
  }

  private async flush() {
    this.flushTimer = undefined;
    const logs = this.buffer;
    this.buffer = [];
    if (!logs.length) return;
    try {
      const stats = await this.liveSerial((p) => p.ingest(logs));
      await this.queueSignals([...stats.newTokens, ...stats.touched]);
      await this.queueMetadata(stats.newTokens);
      await this.handOffPools(this.livePipeline!);
      await this.publish(stats, 'live');
      const newest = Math.max(...logs.map((l) => (l.blockTimestamp ? Number(l.blockTimestamp) : 0)));
      this.live.logs += logs.length;
      this.live.batches++;
      this.live.swaps += stats.swaps;
      this.live.launches += stats.launches;
      this.live.lastLatencyMs = newest ? Date.now() - newest * 1000 : null;
      if (stats.launches) console.log(`live: ${stats.launches} new tokens ${stats.newTokens.join(', ')}`);
    } catch (err) {
      // The polling path picks these blocks up from the cursor.
      console.error('live flush failed', err);
    }
  }
}

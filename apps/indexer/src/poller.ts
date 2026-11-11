import { DurableObject } from 'cloudflare:workers';
import postgres, { type Sql } from 'postgres';
import { ROBINHOOD_CHAIN, tradeTopics, type RawLog } from '@rushr/core';
import { dbUrl, type Env } from './env';
import { Pipeline, type BatchStats, type RangeStats } from './pipeline';
import { tokenSummaries } from './api';
import type { FeedEvent } from './feed';
import { Rpc } from './rpc';

/** ~55s of blocks per getLogs call at 0.11s blocks. */
const RANGE = 500n;
/** Stop a catch-up loop after this long and reschedule, to stay well within alarm limits. */
const BUDGET_MS = 20_000;
/** Live logs are written in small batches this often. */
const FLUSH_MS = 200;
/** Once caught up, polling only confirms what the live path already wrote. */
const POLL_MS = 2_000;
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

  private init() {
    if (!this.pipeline) {
      this.sql = postgres(dbUrl(this.env), { max: 6, fetch_types: false, prepare: false });
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
      live: this.live,
      last: this.last ?? null,
    };
  }

  override async alarm(): Promise<void> {
    if (!(await this.ctx.storage.get<boolean>('enabled'))) return;
    const pipeline = this.init();
    await this.openSocket();
    const rpc = new Rpc(this.env.RPC_URL);
    const started = Date.now();
    let caughtUp = false;
    try {
      const head = (await rpc.blockNumber()) - BigInt(ROBINHOOD_CHAIN.confirmations);
      let cursor: bigint = (await pipeline.cursor()) ?? head - BigInt(this.env.START_BLOCKS_BACK ?? '33000');
      while (Date.now() - started < BUDGET_MS) {
        if (cursor >= head) {
          caughtUp = true;
          break;
        }
        const from = cursor + 1n;
        const to: bigint = cursor + RANGE > head ? head : cursor + RANGE;
        const stats = await this.serial(() => pipeline.run(from, to));
        cursor = to;
        await this.queueSignals([...stats.newTokens, ...stats.touched]);
        await this.queueMetadata(stats.newTokens);
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
      await this.ctx.storage.setAlarm(Date.now() + 5_000);
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + (caughtUp ? POLL_MS : 10));
  }

  /** Open (or keep) the eth_subscribe socket. Called on every alarm, so a drop reconnects within ~2s. */
  private async openSocket(): Promise<void> {
    if (this.ws) return;
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
      await this.env.ENRICH_QUEUE.sendBatch(tokens.slice(i, i + 100).map((token) => ({ body: { kind: 'token-metadata' as const, token } })));
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
    const msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)) as {
      id?: number;
      error?: { message: string };
      params?: { result: RawLog };
    };
    if (msg.id === 1) {
      if (msg.error) console.error('eth_subscribe failed', msg.error.message);
      else this.live.connected = true;
      return;
    }
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

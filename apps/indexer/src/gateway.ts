import { DurableObject } from 'cloudflare:workers';
import postgres, { type Sql } from 'postgres';
import { dbUrl, poller as pollerOf, type Env } from './env';
import { tokenSnapshot, trenchesList, TRENCHES_DEFAULTS, COLUMNS, type Column } from './data';

/**
 * Realtime gateway (protocol v2, docs/realtime.md). Clients are spread over GATEWAY_COUNT instances;
 * each holds its sockets (hibernation API: idle sockets cost nothing), answers subscribes with a
 * snapshot and forwards the poller's sequenced deltas. The poller learns which topics each gateway
 * watches (registerTopics) and only sends a gateway the events it needs.
 */

export const GATEWAY_COUNT = 4;
export const gateway = (env: Env, k: number) => env.GATEWAY.get(env.GATEWAY.idFromName(`gw-${k}`), { locationHint: 'apac' });

export interface DeltaEvent {
  topic: string;
  type: string;
  /** null for messages outside the sequence (hydration snapshots). */
  seq: number | null;
  source: 'index' | 'chain' | 'mixed';
  data: unknown;
}

interface Attachment {
  topics: string[];
  /** Op timestamps (ms) in the current 10s window, for rate limiting. */
  ops: number[];
  principal: { kind: 'anon' | 'agent'; id: string | null; scopes: string[] };
}

const LIMITS = { maxTopics: 50, maxOpsPer10s: 20, pingSeconds: 25 };
const TOPIC = /^(token:0x[0-9a-f]{40}|trenches:(new|almost|migrated))$/;
const SNAPSHOT_TTL_MS = 2_000;
/** Deltas kept per topic for replay after a cached snapshot. */
const RING = 100;
const REGISTER_DEBOUNCE_MS = 250;
/** Re-register with the poller this often (covers a poller restart that lost its registry). */
const HEARTBEAT_MS = 30_000;

export class Gateway extends DurableObject<Env> {
  private sql?: Sql;
  private index = -1;
  private epoch = '';
  /** Last seq forwarded per topic. */
  private lastSeq = new Map<string, number>();
  /** Snapshots cached briefly and shared by concurrent subscribers. */
  private snapshots = new Map<string, { at: number; seq: number; promise: Promise<unknown> }>();
  /** Recent sequenced deltas per topic, replayed after a cached snapshot so it never leaves a gap. */
  private recent = new Map<string, { seq: number; payload: string }[]>();
  /** Deltas held for sockets whose snapshot of that topic is still being built. */
  private pending = new Map<WebSocket, Map<string, string[]>>();
  private registered = '';
  private registerTimer?: ReturnType<typeof setTimeout>;

  private db() {
    this.sql ??= postgres(dbUrl(this.env), { max: 2, fetch_types: false, prepare: false, idle_timeout: 20, max_lifetime: 300, connect_timeout: 10 });
    return this.sql;
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
    this.index = Number(request.headers.get('x-gateway-index') ?? this.index);
    await this.ctx.storage.put('index', this.index);
    const principal = JSON.parse(request.headers.get('x-principal') ?? 'null') ?? { kind: 'anon', id: null, scopes: [] };
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ topics: [], ops: [], principal } satisfies Attachment);
    server.send(JSON.stringify({ type: 'hello', protocol: 2, epoch: await this.currentEpoch(), limits: LIMITS }));
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  private async currentEpoch() {
    if (!this.epoch) this.epoch = (await this.ctx.storage.get<string>('epoch')) ?? '';
    return this.epoch;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: { op?: string; topics?: unknown; topic?: unknown };
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    const att = (ws.deserializeAttachment() as Attachment | null) ?? { topics: [], ops: [], principal: { kind: 'anon', id: null, scopes: [] } };
    if (msg.op === 'ping') return ws.send('{"type":"pong"}');
    const now = Date.now();
    att.ops = att.ops.filter((t) => now - t < 10_000);
    if (att.ops.length >= LIMITS.maxOpsPer10s) {
      ws.send(JSON.stringify({ type: 'error', code: 'rate_limited', message: `at most ${LIMITS.maxOpsPer10s} ops per 10s` }));
      return;
    }
    att.ops.push(now);
    const list = (Array.isArray(msg.topics) ? msg.topics : typeof msg.topic === 'string' ? [msg.topic] : [])
      .filter((t): t is string => typeof t === 'string')
      .map((t) => t.toLowerCase());
    const current = new Set(att.topics);
    const fresh: string[] = [];
    if (msg.op === 'subscribe') {
      for (const t of list) {
        if (!TOPIC.test(t)) {
          ws.send(JSON.stringify({ type: 'error', code: 'bad_topic', message: 'unknown topic', topic: t }));
          continue;
        }
        if (current.has(t)) continue;
        if (current.size >= LIMITS.maxTopics) {
          ws.send(JSON.stringify({ type: 'error', code: 'too_many_topics', message: `at most ${LIMITS.maxTopics} topics`, topic: t }));
          break;
        }
        current.add(t);
        fresh.push(t);
      }
    } else if (msg.op === 'unsubscribe') {
      for (const t of list) current.delete(t);
    } else if (msg.op === 'resync') {
      for (const t of list) if (current.has(t)) fresh.push(t);
    }
    att.topics = [...current];
    ws.serializeAttachment(att);
    if (msg.op !== 'resync') this.scheduleRegister();
    for (const t of fresh) await this.sendSnapshot(ws, t, msg.op === 'resync');
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.pending.delete(ws);
    try {
      ws.close(code, 'closing');
    } catch {
      // already closed
    }
    this.scheduleRegister();
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.pending.delete(ws);
    this.scheduleRegister();
  }

  /** Union of every socket's topics. */
  private watched(): string[] {
    const all = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) for (const t of (ws.deserializeAttachment() as Attachment | null)?.topics ?? []) all.add(t);
    return [...all].sort();
  }

  private scheduleRegister() {
    if (this.registerTimer) clearTimeout(this.registerTimer);
    this.registerTimer = setTimeout(() => void this.register(false), REGISTER_DEBOUNCE_MS);
  }

  /** Tell the poller which topics this gateway watches (only when the set changed, unless forced). */
  private async register(force: boolean) {
    const topics = this.watched();
    const key = topics.join(',');
    if (!force && key === this.registered) return;
    if (this.index < 0) this.index = (await this.ctx.storage.get<number>('index')) ?? 0;
    try {
      const { epoch } = await pollerOf(this.env).registerTopics(this.index, topics);
      this.registered = key;
      if (epoch !== (await this.currentEpoch())) {
        this.epoch = epoch;
        await this.ctx.storage.put('epoch', epoch);
        this.lastSeq.clear();
      }
    } catch (err) {
      console.error('gateway register failed', err);
    }
  }

  override async alarm(): Promise<void> {
    if (!this.ctx.getWebSockets().length) return;
    await this.register(true);
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_MS);
  }

  /** The poller calls this on start so gateways re-register at once (its registry lives in memory). */
  async hello(epoch: string): Promise<void> {
    if (epoch !== (await this.currentEpoch())) {
      this.epoch = epoch;
      await this.ctx.storage.put('epoch', epoch);
      this.lastSeq.clear();
    }
    if (this.ctx.getWebSockets().length) await this.register(true);
  }

  /** Snapshot for one socket: built once per topic per 2s and shared, then held deltas are flushed. */
  private async sendSnapshot(ws: WebSocket, topic: string, resync: boolean) {
    const hold = this.pending.get(ws) ?? new Map<string, string[]>();
    hold.set(topic, []);
    this.pending.set(ws, hold);
    try {
      let entry = this.snapshots.get(topic);
      const ring = this.recent.get(topic) ?? [];
      // A cached snapshot is usable only if the ring still holds every delta since it.
      const covered = (s: number) => this.lastSeq.get(topic) === s || (ring.length > 0 && ring[0]!.seq <= s + 1);
      if (!entry || resync || Date.now() - entry.at > SNAPSHOT_TTL_MS || !covered(entry.seq)) {
        // Sequence first, data second: the data then includes at least everything up to that seq.
        const seq = this.lastSeq.get(topic) ?? (await pollerOf(this.env).seqOf([topic]))[topic] ?? 0;
        entry = { at: Date.now(), seq, promise: this.build(topic) };
        this.snapshots.set(topic, entry);
        if (this.snapshots.size > 300) this.snapshots.delete(this.snapshots.keys().next().value!);
      }
      const data = await entry.promise;
      if (!data) {
        ws.send(JSON.stringify({ type: 'error', code: 'bad_topic', message: 'unknown token', topic }));
      } else {
        ws.send(JSON.stringify({ topic, type: 'snapshot', epoch: await this.currentEpoch(), seq: entry.seq, source: 'index', data }));
        const replay = (this.recent.get(topic) ?? []).filter((d) => d.seq > entry!.seq);
        for (const d of replay) ws.send(d.payload);
        // Held deltas are flushed below; skip the ones the ring already replayed.
        const sentUpTo = replay.at(-1)?.seq ?? entry.seq;
        hold.set(topic, (hold.get(topic) ?? []).filter((p) => {
          const seq = (JSON.parse(p) as { seq: number | null }).seq;
          return seq == null || seq > sentUpTo;
        }));
      }
    } catch (err) {
      console.error('snapshot failed', topic, err);
      this.snapshots.delete(topic);
      ws.send(JSON.stringify({ type: 'error', code: 'snapshot_failed', message: 'retry with resync', topic }));
    } finally {
      for (const payload of hold.get(topic) ?? []) ws.send(payload);
      hold.delete(topic);
      if (!hold.size) this.pending.delete(ws);
    }
  }

  private async build(topic: string): Promise<unknown> {
    const sql = this.db();
    if (topic.startsWith('token:')) {
      const snap = await tokenSnapshot(sql, this.env.RPC_URL, topic.slice(6));
      return snap ? { state: 'live', ...snap } : null;
    }
    const column = topic.slice('trenches:'.length) as Column;
    if (!COLUMNS.includes(column)) return null;
    return { tokens: await trenchesList(sql, { ...TRENCHES_DEFAULTS, column }) };
  }

  /** From the poller (and hydrators): deliver events to the sockets subscribed to their topic. */
  async publish(epoch: string, events: DeltaEvent[]): Promise<number> {
    if (epoch && epoch !== (await this.currentEpoch())) {
      // The poller restarted: its sequences restarted too. Clients see the new epoch and resync.
      this.epoch = epoch;
      await this.ctx.storage.put('epoch', epoch);
      this.lastSeq.clear();
      this.recent.clear();
      this.snapshots.clear();
    }
    const encoded = events.map((e) => {
      const payload = JSON.stringify({ topic: e.topic, type: e.type, epoch: this.epoch, seq: e.seq, source: e.source, data: e.data });
      if (e.seq != null) {
        this.lastSeq.set(e.topic, e.seq);
        const ring = this.recent.get(e.topic) ?? [];
        ring.push({ seq: e.seq, payload });
        if (ring.length > RING) ring.shift();
        this.recent.set(e.topic, ring);
      }
      return { topic: e.topic, payload };
    });
    let sent = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const topics = new Set((ws.deserializeAttachment() as Attachment | null)?.topics ?? []);
      const held = this.pending.get(ws);
      for (const e of encoded) {
        if (!topics.has(e.topic)) continue;
        const buf = held?.get(e.topic);
        if (buf) {
          buf.push(e.payload);
          continue;
        }
        try {
          ws.send(e.payload);
          sent++;
        } catch {
          // closing
        }
      }
    }
    // Hydration snapshots replace the cached one.
    for (const e of events) if (e.type === 'snapshot') this.snapshots.delete(e.topic);
    if (this.recent.size > 500) for (const t of [...this.recent.keys()].slice(0, 100)) this.recent.delete(t);
    return sent;
  }

  async stats() {
    return { sockets: this.ctx.getWebSockets().length, topics: this.watched().length, epoch: await this.currentEpoch() };
  }
}

export { COLUMNS };

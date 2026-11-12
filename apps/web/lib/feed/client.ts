'use client';

import { API_URL } from '../api';
import {
  blockTimeOf,
  fromV1,
  hydrationOf,
  isEnvelope,
  isV1Event,
  type ClientMessage,
  type Delta,
  type Envelope,
  type Hydration,
  type ProtocolVersion,
  type ServerMessage,
} from './protocol';

/**
 * The terminal's feed client: one WebSocket per tab, shared by every component.
 *
 * - Topics are ref-counted: the first subscriber opens the server subscription, the last one
 *   closes it, and everyone in between shares one state.
 * - Each topic's state = a snapshot plus deltas folded in by the topic's reducer. On v2 the server
 *   sends the snapshot and numbered deltas within an epoch; a gap or a new epoch triggers a resync.
 *   On v1 (today) snapshots come from HTTP (or the server-rendered page) and deltas are bare events.
 * - Reconnects with backoff and resubscribes; on v1 it re-reads snapshots over HTTP to cover what
 *   was missed. While the socket is down, topics fall back to polling their HTTP snapshot.
 * - Deltas are applied in batches, at most once per frame, so a burst of trades costs one render.
 */

export type Phase = 'pending' | 'live' | 'resyncing' | 'fallback';

export interface TopicSpec<S> {
  topic: string;
  /**
   * What shape of state this spec builds. An idle entry of another kind (e.g. the pending-token
   * shell handing over to the full token page) is replaced rather than shared.
   */
  kind?: string;
  /** Starting state, usually from the server-rendered page. */
  initial: S;
  /** True when `initial` is already a full snapshot (skip the first HTTP fetch on v1). */
  initialIsSnapshot?: boolean;
  /** Fold a batch of deltas into the state. Must be pure and tolerate duplicates. */
  apply(state: S, deltas: Delta[]): S;
  /** State from a v2 snapshot payload. Defaults to replacing the state. */
  fromSnapshot?(data: unknown, prev: S): S;
  /**
   * HTTP snapshot, for v1 servers, resyncs and while the socket is down. `attempt` is 0 the first
   * time, so it can reuse a server-started promise. May return an updater to merge into prev.
   */
  fetchSnapshot?(signal: AbortSignal, attempt: number): Promise<S | ((prev: S) => S)>;
}

export interface TopicView<S> {
  data: S;
  phase: Phase;
  hydration: Hydration;
  /** Last applied v2 sequence number (null before a numbered snapshot, and on v1). */
  seq: number | null;
  /** True once a v2 server snapshot (numbered or hydrating) has been applied. */
  fromServer: boolean;
}

export interface FeedStatus {
  connected: boolean;
  protocol: ProtocolVersion | null;
  /** Block → browser latency of the last live delta. */
  latencyMs: number | null;
}

type DeltaListener = (deltas: Delta[]) => void;

const WS_URL = `${API_URL.replace(/^http/, 'ws')}/ws?v=2`;
const DEFAULT_PING_MS = 25_000;
/** A v2 server's first frame is hello; a v1 server never sends one. */
const HELLO_TIMEOUT_MS = 2_000;
/** Socket down this long → topics start polling their HTTP snapshot. */
const FALLBACK_AFTER_MS = 3_000;
const FALLBACK_POLL_MS = 15_000;
const READY: Hydration = { state: 'ready' };

class Entry<S> {
  refs = 0;
  view: TopicView<S>;
  /** Deltas waiting for the next flush. */
  queue: Delta[] = [];
  /** Waiting for a v2 snapshot (after subscribe, a gap or a new epoch): deltas are dropped. */
  awaitingSnapshot = false;
  /** Waiting for an HTTP snapshot: deltas are held and replayed on top. */
  awaitingHttp = false;
  held: Delta[] = [];
  /**
   * Last sequence number accepted (queued or applied) and its epoch. Gap checks use this, not
   * `view.seq`, which only moves when a batch is flushed.
   */
  lastSeq: number | null = null;
  epoch: string | null = null;
  attempts = 0;
  fetchCtl: AbortController | null = null;
  pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    public spec: TopicSpec<S>,
    private notify: () => void,
  ) {
    this.view = { data: spec.initial, phase: spec.initialIsSnapshot ? 'live' : 'pending', hydration: READY, seq: null, fromServer: false };
  }

  set(next: Partial<TopicView<S>>) {
    this.view = { ...this.view, ...next };
    this.notify();
  }
}

class FeedClient {
  private socket: WebSocket | null = null;
  private retry = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private downTimer: ReturnType<typeof setTimeout> | undefined;
  private flushScheduled = false;
  private connections = 0;
  private entries = new Map<string, Entry<unknown>>();
  /** Topics the server has us subscribed to on this socket (a replaced entry reuses the subscription). */
  private serverTopics = new Set<string>();
  /** Watchers live outside entries so components can listen before (or after) a topic is open. */
  private watchers = new Map<string, Set<() => void>>();
  private deltaWatchers = new Map<string, Set<DeltaListener>>();
  private errorWatchers = new Map<string, Set<(code: string) => void>>();
  private status: FeedStatus = { connected: false, protocol: null, latencyMs: null };
  private statusListeners = new Set<() => void>();
  /** Raw v1 listeners for code not yet on topic specs. */
  private rawListeners = new Map<string, Set<(e: { topic: string; type: string; data: unknown }) => void>>();

  /* ---------------------------------------------------------------- public */

  /** Subscribe to a topic. Returns the release function. The first spec registered for a topic wins. */
  retain<S>(spec: TopicSpec<S>): () => void {
    const key = spec.topic.toLowerCase();
    let e = this.entries.get(key) as Entry<S> | undefined;
    if (e && e.refs === 0 && (e.spec.kind ?? '') !== (spec.kind ?? '')) {
      e.fetchCtl?.abort();
      clearInterval(e.pollTimer);
      this.entries.delete(key);
      e = undefined;
    }
    if (!e) {
      e = new Entry(spec, () => this.watchers.get(key)?.forEach((l) => l()));
      this.entries.set(key, e as Entry<unknown>);
      this.watchers.get(key)?.forEach((l) => l());
    }
    const entry = e;
    if (entry.refs++ === 0) this.open(key, entry);
    this.connect();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--entry.refs > 0) return;
      // Keep the state briefly so a quick remount (route change, StrictMode) doesn't refetch.
      setTimeout(() => {
        if (entry.refs > 0 || this.entries.get(key) !== entry) return;
        this.close(key, entry);
        this.entries.delete(key);
      }, 5_000);
    };
  }

  /** A topic's state, if it is open with a spec of this kind (another kind's state has another shape). */
  view<S>(topic: string, kind?: string): TopicView<S> | undefined {
    const e = this.entries.get(topic.toLowerCase());
    if (!e || (kind !== undefined && (e.spec.kind ?? '') !== kind)) return undefined;
    return e.view as TopicView<S>;
  }

  watch(topic: string, listener: () => void): () => void {
    return addTo(this.watchers, topic.toLowerCase(), listener);
  }

  /** Every batch of deltas for a topic, after it has been applied (for flashes and other effects). */
  onDeltas(topic: string, listener: DeltaListener): () => void {
    return addTo(this.deltaWatchers, topic.toLowerCase(), listener);
  }

  /** Server errors for a topic (`bad_topic`, `not_a_token`, …). */
  onError(topic: string, listener: (code: string) => void): () => void {
    return addTo(this.errorWatchers, topic.toLowerCase(), listener);
  }

  /** Legacy raw subscription (v1 event shape) for code that hasn't moved to topic specs. */
  raw(topic: string, listener: (e: { topic: string; type: string; data: unknown }) => void): () => void {
    const key = topic.toLowerCase();
    // Shares the topic with whatever spec is open; only listens for raw events.
    const existing = this.entries.get(key);
    const release = this.retain(existing ? existing.spec : { topic: key, kind: 'raw', initial: null, initialIsSnapshot: true, apply: (s) => s });
    const stop = addTo(this.rawListeners, key, listener);
    return () => {
      stop();
      release();
    };
  }

  getStatus = () => this.status;
  subscribeStatus = (cb: () => void) => {
    this.statusListeners.add(cb);
    this.connect();
    return () => this.statusListeners.delete(cb);
  };

  /* ---------------------------------------------------------------- topics */

  private open<S>(topic: string, e: Entry<S>) {
    if (this.status.protocol === 2 && this.serverTopics.has(topic)) {
      // Still subscribed (an entry of another kind just handed over): ask for a fresh snapshot.
      e.awaitingSnapshot = true;
      this.send({ op: 'resync', topic });
    } else {
      // `subscribe` is the same op in v1 and v2, so it goes out before we know the protocol.
      this.subscribeTopics([topic]);
      if (this.status.protocol === 2) e.awaitingSnapshot = true;
    }
    if (this.status.protocol === 2) return;
    if (!e.spec.initialIsSnapshot) void this.httpSnapshot(topic, e);
    if (!this.status.connected) this.startFallback(topic, e);
  }

  private close<S>(topic: string, e: Entry<S>) {
    e.fetchCtl?.abort();
    clearInterval(e.pollTimer);
    this.serverTopics.delete(topic);
    this.send({ op: 'unsubscribe', topics: [topic] });
  }

  private subscribeTopics(topics: string[]) {
    if (!topics.length || this.socket?.readyState !== WebSocket.OPEN) return;
    topics.forEach((t) => this.serverTopics.add(t));
    this.send({ op: 'subscribe', topics });
  }

  private resync<S>(topic: string, e: Entry<S>) {
    e.awaitingSnapshot = true;
    e.queue.length = 0;
    e.set({ phase: 'resyncing' });
    this.send({ op: 'resync', topic });
  }

  /** HTTP snapshot. Deltas arriving meanwhile are held and replayed on top (reducers are idempotent). */
  private async httpSnapshot<S>(topic: string, e: Entry<S>) {
    const fetcher = e.spec.fetchSnapshot;
    if (!fetcher) {
      if (e.view.phase === 'pending') e.set({ phase: 'live' });
      return;
    }
    e.fetchCtl?.abort();
    const ctl = new AbortController();
    e.fetchCtl = ctl;
    e.awaitingHttp = true;
    const finish = (base: S) => {
      e.awaitingHttp = false;
      const held = e.held.splice(0);
      e.set({ data: held.length ? e.spec.apply(base, held) : base, phase: this.status.connected || this.status.protocol == null ? 'live' : 'fallback' });
    };
    try {
      const snap = await fetcher(ctl.signal, e.attempts++);
      if (ctl.signal.aborted || this.entries.get(topic) !== (e as Entry<unknown>)) return;
      finish(typeof snap === 'function' ? (snap as (p: S) => S)(e.view.data) : snap);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      // Keep what we have; deltas keep flowing.
      finish(e.view.data);
    }
  }

  private startFallback<S>(topic: string, e: Entry<S>) {
    if (!e.spec.fetchSnapshot || e.pollTimer) return;
    e.pollTimer = setInterval(() => {
      if (this.status.connected) {
        clearInterval(e.pollTimer);
        e.pollTimer = undefined;
        return;
      }
      if (e.view.phase !== 'fallback') e.set({ phase: 'fallback' });
      void this.httpSnapshot(topic, e);
    }, FALLBACK_POLL_MS);
  }

  private deliver(topic: string, delta: Delta, epoch?: string) {
    const e = this.entries.get(topic);
    if (!e) return;
    if (this.status.protocol === 2) {
      if (e.awaitingSnapshot) return; // dropped until the snapshot (spec)
      if (epoch && e.epoch && epoch !== e.epoch) return this.resync(topic, e);
      if (delta.seq != null) {
        if (e.lastSeq == null) return this.resync(topic, e); // numbered delta without a numbered snapshot
        if (delta.seq <= e.lastSeq) return; // duplicate
        if (delta.seq !== e.lastSeq + 1) return this.resync(topic, e); // gap
        e.lastSeq = delta.seq;
      }
      // seq null: unnumbered (hydration) delta, applied idempotently.
    } else if (e.awaitingHttp) {
      e.held.push(delta);
      return;
    }
    e.queue.push(delta);
    this.scheduleFlush();
  }

  private snapshot(topic: string, msg: Envelope) {
    const e = this.entries.get(topic);
    if (!e) return;
    e.fetchCtl?.abort();
    e.awaitingHttp = false;
    e.held.length = 0;
    const data = msg.data as { state?: unknown; progress?: unknown } | null;
    const base = e.spec.fromSnapshot ? e.spec.fromSnapshot(msg.data, e.view.data) : (msg.data as typeof e.view.data);
    e.awaitingSnapshot = false;
    e.lastSeq = msg.seq;
    e.epoch = msg.epoch;
    // Anything queued before this snapshot is already in it.
    e.queue.length = 0;
    e.set({ data: base, seq: msg.seq, phase: 'live', fromServer: true, hydration: hydrationOf(data?.state, msg.source, data?.progress) });
  }

  private scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    const run = () => {
      this.flushScheduled = false;
      for (const [topic, e] of this.entries) {
        if (!e.queue.length) continue;
        const batch = e.queue.splice(0);
        const next = e.spec.apply(e.view.data, batch);
        const seq = batch.reduce<number | null>((s, d) => (d.seq != null ? Math.max(s ?? 0, d.seq) : s), e.view.seq);
        // `state` deltas move the hydration state; the last one in the batch wins.
        const state = [...batch].reverse().find((d) => d.kind === 'state');
        const sd = state?.data as { state?: unknown; progress?: unknown } | undefined;
        const hydration = sd ? hydrationOf(sd.state, (state!.source as Hydration['source']) ?? e.view.hydration.source, sd.progress) : e.view.hydration;
        if (next !== e.view.data || seq !== e.view.seq || hydration !== e.view.hydration) e.set({ data: next, seq, hydration });
        this.deltaWatchers.get(topic)?.forEach((l) => l(batch));
      }
    };
    // rAF pauses in background tabs; fall back to a timer there so state keeps up.
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 100);
  }

  /* ---------------------------------------------------------------- socket */

  private send(msg: ClientMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  private setStatus(next: Partial<FeedStatus>) {
    this.status = { ...this.status, ...next };
    this.statusListeners.forEach((l) => l());
  }

  private connect() {
    if (typeof window === 'undefined' || this.socket) return;
    const ws = new WebSocket(WS_URL);
    this.socket = ws;
    ws.onopen = () => {
      this.retry = 0;
      clearTimeout(this.downTimer);
      this.setStatus({ connected: true, protocol: null });
      // Subscribe at once (same op in v1 and v2), so a v1 server streams without waiting for the
      // hello timeout. A v2 server answers with hello first, then snapshots.
      this.serverTopics.clear();
      this.subscribeTopics([...this.entries.keys()]);
      this.helloTimer = setTimeout(() => this.negotiated(1), HELLO_TIMEOUT_MS);
      this.startPing(DEFAULT_PING_MS);
    };
    ws.onmessage = (raw) => this.onMessage(raw.data as string);
    ws.onclose = () => {
      this.socket = null;
      clearInterval(this.pingTimer);
      clearTimeout(this.helloTimer);
      // Unknown again until the next hello: topics opened meanwhile fall back to HTTP.
      this.setStatus({ connected: false, protocol: null });
      this.downTimer = setTimeout(() => {
        for (const [topic, e] of this.entries) this.startFallback(topic, e);
      }, FALLBACK_AFTER_MS);
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private startPing(ms: number) {
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.send({ op: 'ping' }), ms);
  }

  private negotiated(v: ProtocolVersion, hello?: Extract<ServerMessage, { type: 'hello' }>) {
    if (this.status.protocol != null) return;
    clearTimeout(this.helloTimer);
    this.setStatus({ protocol: v });
    if (hello?.limits?.pingSeconds) this.startPing(hello.limits.pingSeconds * 1000);
    for (const [topic, e] of this.entries) {
      clearInterval(e.pollTimer);
      e.pollTimer = undefined;
      if (v === 2) {
        // The subscribe sent on open gets a snapshot; until then deltas are dropped.
        e.awaitingSnapshot = true;
        e.lastSeq = null;
        e.epoch = null;
      } else if (this.connections > 0) {
        // v1 has no snapshots or sequence numbers: after a reconnect, re-read over HTTP whatever
        // may have been missed. (The first snapshot was already started when the topic opened.)
        void this.httpSnapshot(topic, e);
      }
    }
    this.connections++;
  }

  private onMessage(text: string) {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (isV1Event(m)) {
      if (this.status.protocol == null) this.negotiated(1);
      const topic = m.topic.toLowerCase();
      const delta = fromV1(m);
      this.latency(delta);
      this.rawListeners.get(topic)?.forEach((l) => l(m as { topic: string; type: string; data: unknown }));
      this.deliver(topic, delta);
      return;
    }
    if (isEnvelope(m)) {
      const topic = m.topic.toLowerCase();
      if (m.type === 'snapshot') return this.snapshot(topic, m);
      const delta: Delta = { kind: m.type, data: m.data, seq: m.seq, blockTime: blockTimeOf(m.type, m.data), source: m.source };
      this.latency(delta);
      return this.deliver(topic, delta, m.epoch);
    }
    const msg = m as ServerMessage;
    switch (msg.type) {
      case 'hello':
        return this.negotiated(2, msg as Extract<ServerMessage, { type: 'hello' }>);
      case 'subscribed':
        return this.negotiated(1);
      case 'error': {
        const err = msg as { code: string; topic?: string };
        if (err.topic) this.errorWatchers.get(err.topic.toLowerCase())?.forEach((l) => l(err.code));
        return;
      }
      case 'resync_needed': {
        const topic = (msg as { topic: string }).topic.toLowerCase();
        const e = this.entries.get(topic);
        if (e) this.resync(topic, e);
        return;
      }
      default:
        return;
    }
  }

  private latency(d: Delta) {
    // Only the live path measures feed speed; poll/backfill events would skew it.
    if (d.source === 'poll' || d.source === 'chain' || !d.blockTime) return;
    this.setStatus({ latencyMs: Date.now() - d.blockTime * 1000 });
  }
}

function addTo<T>(map: Map<string, Set<T>>, key: string, value: T): () => void {
  let set = map.get(key);
  if (!set) map.set(key, (set = new Set()));
  set.add(value);
  return () => {
    set!.delete(value);
    if (!set!.size && map.get(key) === set) map.delete(key);
  };
}

/** The tab's single client. */
export const feed = new FeedClient();

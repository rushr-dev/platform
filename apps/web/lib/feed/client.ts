'use client';

import { API_URL } from '../api';
import { fromV1, isV1Event, type ClientMessage, type Delta, type Hydration, type ProtocolVersion, type ServerMessage } from './protocol';

/**
 * The terminal's feed client: one WebSocket per tab, shared by every component.
 *
 * - Topics are ref-counted: the first subscriber opens the server subscription, the last one
 *   closes it, and everyone in between shares one state.
 * - Each topic's state = a snapshot plus deltas folded in by the topic's reducer. On v2 the server
 *   sends the snapshot and numbered deltas; a gap in the numbers triggers a resync. On v1 (today)
 *   snapshots come from HTTP (or the server-rendered page) and deltas are the bare events.
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
  /** Last applied v2 sequence number. */
  seq: number | null;
}

export interface FeedStatus {
  connected: boolean;
  protocol: ProtocolVersion | null;
  /** Block → browser latency of the last live delta. */
  latencyMs: number | null;
}

type DeltaListener = (deltas: Delta[]) => void;

const WS_URL = `${API_URL.replace(/^http/, 'ws')}/ws`;
const PING_MS = 25_000;
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
  /** Deltas held back while a snapshot is on its way. */
  held: Delta[] = [];
  awaitingSnapshot = false;
  /**
   * Last sequence number accepted (queued or applied). Gap checks use this, not `view.seq`, which
   * only moves when a batch is flushed: two back-to-back deltas must not look like a gap.
   */
  lastSeq: number | null = null;
  /** Subscribed with `since`: the server may resume with deltas instead of a snapshot. */
  resuming = false;
  attempts = 0;
  fetchCtl: AbortController | null = null;
  pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    public spec: TopicSpec<S>,
    private notify: () => void,
  ) {
    this.view = { data: spec.initial, phase: spec.initialIsSnapshot ? 'live' : 'pending', hydration: READY, seq: null };
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
  private entries = new Map<string, Entry<unknown>>();
  /** Watchers live outside entries so components can listen before (or after) a topic is open. */
  private watchers = new Map<string, Set<() => void>>();
  private deltaWatchers = new Map<string, Set<DeltaListener>>();
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

  /** Apply local changes to a topic's state (e.g. a server-rendered promise that resolved). */
  update<S>(topic: string, fn: (prev: S) => S) {
    const e = this.entries.get(topic.toLowerCase()) as Entry<S> | undefined;
    if (e) e.set({ data: fn(e.view.data) });
  }

  /** Legacy raw subscription (v1 event shape) for code that hasn't moved to topic specs. */
  raw(topic: string, listener: (e: { topic: string; type: string; data: unknown }) => void): () => void {
    const key = topic.toLowerCase();
    // Shares the topic with whatever spec is open; only listens for raw events.
    const existing = this.entries.get(key);
    const release = this.retain(existing ? existing.spec : { topic: key, kind: 'raw', initial: null, initialIsSnapshot: true, apply: (s) => s });
    let set = this.rawListeners.get(key);
    if (!set) this.rawListeners.set(key, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
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
    this.sendSub(topic, e);
    if (this.status.protocol !== 2 && !e.spec.initialIsSnapshot) void this.httpSnapshot(topic, e);
    if (!this.status.connected) this.startFallback(topic, e);
  }

  private close<S>(topic: string, e: Entry<S>) {
    e.fetchCtl?.abort();
    clearInterval(e.pollTimer);
    if (this.status.protocol === 2) this.send({ op: 'unsub', topic });
    else this.send({ op: 'unsubscribe', topics: [topic] });
  }

  private sendSub<S>(topic: string, e: Entry<S>) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    // Still negotiating: subscribe the v1 way now (a v2 server ignores it; we `sub` on its hello).
    if (this.status.protocol == null) return this.send({ op: 'subscribe', topics: [topic] });
    if (this.status.protocol === 2) {
      e.awaitingSnapshot = true;
      e.resuming = e.lastSeq != null;
      this.send({ op: 'sub', topic, ...(e.lastSeq != null ? { since: e.lastSeq } : {}) });
    } else {
      this.send({ op: 'subscribe', topics: [topic] });
    }
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
    e.awaitingSnapshot = true;
    try {
      const snap = await fetcher(ctl.signal, e.attempts++);
      if (ctl.signal.aborted || this.entries.get(topic) !== (e as Entry<unknown>)) return;
      const base = typeof snap === 'function' ? (snap as (p: S) => S)(e.view.data) : snap;
      e.awaitingSnapshot = false;
      const held = e.held.splice(0);
      e.set({ data: held.length ? e.spec.apply(base, held) : base, phase: this.status.connected || this.status.protocol == null ? 'live' : 'fallback' });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      // Keep what we have; deltas keep flowing.
      e.awaitingSnapshot = false;
      const held = e.held.splice(0);
      if (held.length) e.set({ data: e.spec.apply(e.view.data, held) });
      if (e.view.phase === 'pending') e.set({ phase: 'live' });
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

  private deliver(topic: string, delta: Delta) {
    const e = this.entries.get(topic);
    if (!e) return;
    if (delta.seq != null && e.lastSeq != null && !e.awaitingSnapshot) {
      if (delta.seq <= e.lastSeq) return; // duplicate or replay
      if (delta.seq !== e.lastSeq + 1) {
        // Gap: we missed something. Hold everything from here and ask for a fresh snapshot.
        e.awaitingSnapshot = true;
        e.resuming = false;
        e.held.push(delta);
        e.set({ phase: 'resyncing' });
        this.send({ op: 'resync', topic });
        return;
      }
    }
    // Resumed after a reconnect: the next delta in line ends the wait, no snapshot needed.
    if (e.awaitingSnapshot && e.resuming && delta.seq != null && e.lastSeq != null && delta.seq === e.lastSeq + 1) {
      e.awaitingSnapshot = false;
      e.resuming = false;
      if (e.view.phase !== 'live') e.set({ phase: 'live' });
    }
    if (e.awaitingSnapshot) {
      e.held.push(delta);
      return;
    }
    if (delta.seq != null) e.lastSeq = delta.seq;
    e.queue.push(delta);
    this.scheduleFlush();
  }

  private snapshot(topic: string, msg: Extract<ServerMessage, { type: 'snapshot' }>) {
    const e = this.entries.get(topic);
    if (!e) return;
    e.fetchCtl?.abort();
    const base = e.spec.fromSnapshot ? e.spec.fromSnapshot(msg.data, e.view.data) : msg.data;
    // Replay held deltas newer than the snapshot, in order, then carry on from there.
    const later = e.held.splice(0).filter((d) => d.seq == null || d.seq > msg.seq).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    let seq = msg.seq;
    const contiguous: typeof later = [];
    for (const d of later) {
      if (d.seq != null && d.seq !== seq + 1) break;
      contiguous.push(d);
      if (d.seq != null) seq = d.seq;
    }
    e.awaitingSnapshot = false;
    e.resuming = false;
    e.lastSeq = seq;
    // Anything queued before this snapshot is already in it.
    e.queue.length = 0;
    e.set({
      data: contiguous.length ? e.spec.apply(base, contiguous) : base,
      seq,
      phase: 'live',
      hydration: { state: msg.state ?? 'ready', source: msg.source, progress: msg.progress ?? null },
    });
    if (contiguous.length < later.length) {
      // Still a hole after the snapshot: ask again.
      e.awaitingSnapshot = true;
      e.set({ phase: 'resyncing' });
      this.send({ op: 'resync', topic });
    }
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
        if (next !== e.view.data || seq !== e.view.seq) e.set({ data: next, seq });
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
      // Ask for v2. A v2 server answers "hello"; today's server answers anything with "subscribed".
      this.setStatus({ connected: true, protocol: null });
      this.send({ op: 'hello', v: 2 });
      // Subscribe the v1 way at once so today's server streams without waiting a round trip. A v2
      // server ignores v1 ops from a socket that said hello; we re-subscribe with `sub` on its reply.
      if (this.entries.size) this.send({ op: 'subscribe', topics: [...this.entries.keys()] });
      this.helloTimer = setTimeout(() => this.negotiated(1), HELLO_TIMEOUT_MS);
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.send({ op: 'ping' }), PING_MS);
    };
    ws.onmessage = (raw) => this.onMessage(raw.data as string);
    ws.onclose = () => {
      this.socket = null;
      clearInterval(this.pingTimer);
      clearTimeout(this.helloTimer);
      this.setStatus({ connected: false });
      this.downTimer = setTimeout(() => {
        for (const [topic, e] of this.entries) this.startFallback(topic, e);
      }, FALLBACK_AFTER_MS);
      const delay = Math.min(10_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  private negotiated(v: ProtocolVersion) {
    if (this.status.protocol != null) return;
    clearTimeout(this.helloTimer);
    this.setStatus({ protocol: v });
    for (const [topic, e] of this.entries) {
      clearInterval(e.pollTimer);
      e.pollTimer = undefined;
      if (v === 2) {
        this.sendSub(topic, e);
      } else {
        // v1 has no snapshots or sequence numbers: after a reconnect, re-read over HTTP whatever may
        // have been missed. (The first snapshot was already started when the topic opened.)
        this.send({ op: 'subscribe', topics: [topic] });
        if (this.connections > 0) void this.httpSnapshot(topic, e);
      }
    }
    this.connections++;
  }

  private connections = 0;

  private onMessage(text: string) {
    let m: ServerMessage | unknown;
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
    const msg = m as ServerMessage;
    switch (msg.type) {
      case 'hello':
        return this.negotiated(2);
      case 'subscribed':
        return this.negotiated(1);
      case 'snapshot':
        return this.snapshot(msg.topic.toLowerCase(), msg);
      case 'delta': {
        const delta: Delta = { kind: msg.kind, data: msg.data, seq: msg.seq, blockTime: msg.block_time ?? null, source: msg.source };
        this.latency(delta);
        return this.deliver(msg.topic.toLowerCase(), delta);
      }
      case 'state': {
        const e = this.entries.get(msg.topic.toLowerCase());
        e?.set({ hydration: { state: msg.state, source: msg.source, progress: msg.progress ?? null } });
        return;
      }
      default:
        return;
    }
  }

  private latency(d: Delta) {
    // Only the live path measures feed speed; poll events are backfill of blocks the socket missed.
    if (d.source === 'poll' || !d.blockTime) return;
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

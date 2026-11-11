'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { API_URL } from './api';

/**
 * One shared WebSocket to the indexer's LiveFeed for the whole tab. Components subscribe to
 * topics ("trenches", "token:0x…"); the socket reconnects with backoff and resubscribes.
 */

export interface LiveEvent {
  topic: string;
  type: 'token' | 'trades' | 'launch';
  data: unknown;
  source?: 'live' | 'poll';
}

type Listener = (e: LiveEvent) => void;

const WS_URL = `${API_URL.replace(/^http/, 'ws')}/ws`;

let socket: WebSocket | null = null;
let retry = 0;
let pingTimer: ReturnType<typeof setInterval> | undefined;
const listeners = new Map<string, Set<Listener>>();

/** Connection state and the latest block → browser latency, for the status pill. */
let status: { connected: boolean; latencyMs: number | null } = { connected: false, latencyMs: null };
const statusListeners = new Set<() => void>();
function setStatus(next: Partial<typeof status>) {
  status = { ...status, ...next };
  statusListeners.forEach((l) => l());
}

function send(msg: object) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

function connect() {
  if (typeof window === 'undefined' || socket) return;
  const ws = new WebSocket(WS_URL);
  socket = ws;
  ws.onopen = () => {
    retry = 0;
    setStatus({ connected: true });
    if (listeners.size) send({ op: 'subscribe', topics: [...listeners.keys()] });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ op: 'ping' }), 25_000);
  };
  ws.onmessage = (msg) => {
    let e: LiveEvent;
    try {
      e = JSON.parse(msg.data as string);
    } catch {
      return;
    }
    if (!e.topic) return;
    // Only the live path measures feed speed; poll events are backfill of blocks the socket missed.
    const latency = e.source === 'live' ? blockTimeOf(e) : null;
    if (latency) setStatus({ latencyMs: Date.now() - latency * 1000 });
    listeners.get(e.topic)?.forEach((l) => l(e));
  };
  ws.onclose = () => {
    socket = null;
    clearInterval(pingTimer);
    setStatus({ connected: false });
    const delay = Math.min(10_000, 500 * 2 ** retry++);
    setTimeout(connect, delay);
  };
}

function blockTimeOf(e: LiveEvent): number | null {
  if (e.type === 'trades' && Array.isArray(e.data)) {
    const times = (e.data as { time?: number }[]).map((t) => t.time ?? 0);
    return times.length ? Math.max(...times) : null;
  }
  const bt = (e.data as { block_time?: number | null } | null)?.block_time;
  return bt ?? null;
}

export function subscribe(topic: string, listener: Listener): () => void {
  const key = topic.toLowerCase();
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
    send({ op: 'subscribe', topics: [key] });
  }
  set.add(listener);
  connect();
  return () => {
    set!.delete(listener);
    if (!set!.size) {
      listeners.delete(key);
      send({ op: 'unsubscribe', topics: [key] });
    }
  };
}

/** Subscribe to a topic for the component's lifetime. The handler can change without resubscribing. */
export function useLive(topic: string, handler: Listener) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe(topic, (e) => ref.current(e)), [topic]);
}

export function useLiveStatus() {
  return useSyncExternalStore(
    (cb) => {
      statusListeners.add(cb);
      connect();
      return () => statusListeners.delete(cb);
    },
    () => status,
    () => status,
  );
}

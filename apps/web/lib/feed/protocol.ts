/**
 * Wire formats for the terminal feed.
 *
 * v1 is what the LiveFeed Durable Object speaks today: subscribe/unsubscribe, and bare events with
 * no sequence numbers and no snapshots (the client gets snapshots over HTTP).
 *
 * v2 is the WebSocket-first protocol the terminal is ready for (proposal in docs/team-plan.md,
 * Requests → "Feed protocol v2"): a snapshot on subscribe, then deltas with a per-topic sequence
 * number, plus a hydrating state for tokens the server is still fetching from chain. The client
 * negotiates with a `hello`; a v1 server never answers it, so the client stays on v1.
 */

export type ProtocolVersion = 1 | 2;

/* ------------------------------------------------------------------ v1 (today) */

export interface V1Event {
  topic: string;
  type: 'token' | 'trades' | 'launch';
  data: unknown;
  source?: 'live' | 'poll';
}

/* ------------------------------------------------------------------ v2 (proposed) */

export type HydrationSource = 'chain' | 'index' | 'mixed';

/** Where a topic's data stands. `hydrating`: the server is still backfilling it (from chain or index). */
export interface Hydration {
  state: 'ready' | 'hydrating';
  source?: HydrationSource;
  /** 0..1 when the server can tell. */
  progress?: number | null;
}

export type ClientMessage =
  | { op: 'hello'; v: 2 }
  | { op: 'sub'; topic: string; /** resume from this seq if the server still has it */ since?: number }
  | { op: 'unsub'; topic: string }
  | { op: 'resync'; topic: string }
  | { op: 'ping' }
  // v1 forms
  | { op: 'subscribe'; topics: string[] }
  | { op: 'unsubscribe'; topics: string[] };

export type ServerMessage =
  | { type: 'hello'; v: 2 }
  | { type: 'pong' }
  | { type: 'subscribed'; topics?: string[] }
  | ({ type: 'snapshot'; topic: string; seq: number; data: unknown; block_time?: number } & Partial<Hydration>)
  | { type: 'delta'; topic: string; seq: number; kind: string; data: unknown; block_time?: number; source?: 'live' | 'poll' }
  | ({ type: 'state'; topic: string; seq?: number } & Hydration)
  | { type: 'error'; topic?: string; code: string; message?: string };

/** One change to a topic, whatever the protocol it arrived on. */
export interface Delta {
  kind: string;
  data: unknown;
  /** v2 only. */
  seq?: number;
  /** Unix seconds of the newest block in the delta, for the latency pill. */
  blockTime?: number | null;
  source?: 'live' | 'poll';
}

/** Turn a v1 event into a delta (kinds keep their v1 names: token, trades, launch). */
export function fromV1(e: V1Event): Delta {
  let blockTime: number | null = null;
  if (e.type === 'trades' && Array.isArray(e.data)) {
    const times = (e.data as { time?: number }[]).map((t) => t.time ?? 0);
    blockTime = times.length ? Math.max(...times) : null;
  } else {
    blockTime = (e.data as { block_time?: number | null } | null)?.block_time ?? null;
  }
  return { kind: e.type, data: e.data, blockTime, source: e.source };
}

export const isV1Event = (m: unknown): m is V1Event =>
  !!m && typeof m === 'object' && typeof (m as V1Event).topic === 'string' && typeof (m as V1Event).type === 'string' &&
  ['token', 'trades', 'launch'].includes((m as V1Event).type);

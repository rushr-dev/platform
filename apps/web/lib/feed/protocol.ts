/**
 * Wire formats for the terminal feed.
 *
 * v1 is what the LiveFeed Durable Object speaks today: subscribe/unsubscribe, and bare events with
 * no sequence numbers and no snapshots (the client gets snapshots over HTTP).
 *
 * v2 is the Data stream's realtime protocol (docs/realtime.md on the data branch): connect to
 * `/ws?v=2`, the server's first frame is `hello`, then every topic gets a `snapshot` followed by
 * deltas with a per-topic `seq` inside an `epoch`. A v1 server ignores `?v=2` and never says hello,
 * so the client stays on v1 there.
 */

export type ProtocolVersion = 1 | 2;

/* ------------------------------------------------------------------ v1 (today) */

export interface V1Event {
  topic: string;
  type: 'token' | 'trades' | 'launch';
  data: unknown;
  source?: 'live' | 'poll';
}

/* ------------------------------------------------------------------ v2 */

export type DataSource = 'index' | 'chain' | 'mixed';

/** Where a topic's data stands. `hydrating`/`partial`: the server is still fetching it from chain. */
export interface Hydration {
  state: 'ready' | 'hydrating' | 'partial';
  source?: DataSource;
  /** Unix seconds of the history already covered, when the server says. */
  covered?: { from: number; to: number } | null;
}

export type ClientMessage =
  | { op: 'subscribe'; topics: string[] }
  | { op: 'unsubscribe'; topics: string[] }
  | { op: 'resync'; topic: string }
  | { op: 'ping' };

export interface Hello {
  type: 'hello';
  protocol: 2;
  epoch: string;
  limits?: { maxTopics?: number; maxOpsPer10s?: number; pingSeconds?: number };
}

/** Every topic message: `type` is `snapshot` or the delta kind. */
export interface Envelope {
  topic: string;
  type: string;
  epoch: string;
  seq: number | null;
  source?: DataSource;
  data: unknown;
}

export type ServerMessage =
  | Hello
  | { type: 'pong' }
  | { type: 'subscribed'; topics?: string[] } // v1 reply to any op
  | { type: 'error'; code: string; message?: string; topic?: string }
  | { type: 'resync_needed'; topic: string }
  | Envelope;

/** One change to a topic, whatever the protocol it arrived on. */
export interface Delta {
  kind: string;
  data: unknown;
  /** v2 only; null for unnumbered (hydration) messages. */
  seq?: number | null;
  /** Unix seconds of the newest block in the delta, for the latency pill. */
  blockTime?: number | null;
  source?: string;
}

/** Newest block time in a payload: trades carry `time`, cards may carry `block_time`. */
export function blockTimeOf(kind: string, data: unknown): number | null {
  if (kind === 'trades' && Array.isArray(data)) {
    const times = (data as { time?: number }[]).map((t) => t.time ?? 0);
    return times.length ? Math.max(...times) : null;
  }
  return (data as { block_time?: number | null } | null)?.block_time ?? null;
}

/** Turn a v1 event into a delta (kinds keep their v1 names: token, trades, launch). */
export const fromV1 = (e: V1Event): Delta => ({ kind: e.type, data: e.data, blockTime: blockTimeOf(e.type, e.data), source: e.source });

export const isV1Event = (m: unknown): m is V1Event =>
  !!m && typeof m === 'object' && !('epoch' in m) && typeof (m as V1Event).topic === 'string' && ['token', 'trades', 'launch'].includes((m as V1Event).type);

export const isEnvelope = (m: unknown): m is Envelope => !!m && typeof m === 'object' && typeof (m as Envelope).topic === 'string' && 'epoch' in m;

/** v2 token state names → the client's. */
export function hydrationOf(state: unknown, source?: DataSource, progress?: unknown): Hydration {
  const p = progress as { from?: number; to?: number } | null | undefined;
  const covered = p && Number.isFinite(p.from) && Number.isFinite(p.to) ? { from: p.from!, to: p.to! } : null;
  if (state === 'hydrating' || state === 'partial') return { state, source, covered };
  return { state: 'ready', source };
}

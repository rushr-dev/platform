// The indexer's off switch: while paused, nothing of ours spends RPC except per-user trade calls.
//
// The flag lives in Postgres (indexer_state key 'paused'), so a pause survives deploys and every isolate,
// Durable Object and queue consumer sees it without an RPC call. It's flipped with POST /admin/indexer/pause
// and /resume (scripts/indexer-switch.sh). The poller also keeps its own copy in DO storage (see
// ChainPoller.pause), so its alarm loop stops even if the database is unreachable.
//
// While paused:
//   - scheduled() returns right away (no poller start, no RPC or DB jobs)
//   - the poller has no alarm and its Alchemy socket is closed
//   - Backfiller alarms wait (re-checked every 5 minutes) instead of stepping
//   - queue consumers put messages back with a delay instead of calling RPC
//   - token hydration answers 503 { error: { code: 'paused' } }
//   - DB reads skip their background chain repairs (pool TVL, wallet balances, stale signals)
// Still on: every DB read, and the per-user trade routes (quotes, builds, ledger submit).
import postgres, { type Sql } from 'postgres';
import { dbUrl, type Env } from './env';

export interface PauseState {
  paused: boolean;
  /** When the current pause started (null when running). */
  pausedAt: string | null;
  /** When the last pause ended (null when it never did). */
  resumedAt: string | null;
  reason: string | null;
}

const RUNNING: PauseState = { paused: false, pausedAt: null, resumedAt: null, reason: null };
/** How long an isolate trusts the flag it read. A pause reaches every isolate within this. */
export const PAUSE_CACHE_MS = 10_000;
/** How long a queue message waits before it's looked at again while paused. */
export const PAUSED_REQUEUE_S = 1_800;

let cached: { at: number; state: PauseState } | null = null;

/** The stored row as a PauseState (pure; exported for tests). */
export function parsePause(value: unknown): PauseState {
  if (!value || typeof value !== 'object') return RUNNING;
  const v = value as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' ? x : null);
  return { paused: v.paused === true, pausedAt: v.paused === true ? str(v.pausedAt) : null, resumedAt: str(v.resumedAt), reason: str(v.reason) };
}

/** The pause flag (cached per isolate for PAUSE_CACHE_MS unless `fresh`). A failed read counts as running. */
export async function readPause(sql: Sql, opts: { fresh?: boolean } = {}): Promise<PauseState> {
  if (!opts.fresh && cached && Date.now() - cached.at < PAUSE_CACHE_MS) return cached.state;
  try {
    const [row] = await sql<{ value: unknown }[]>`select value from indexer_state where key = 'paused'`;
    const state = parsePause(row?.value);
    cached = { at: Date.now(), state };
    return state;
  } catch (err) {
    console.error('pause flag read failed', err);
    return cached?.state ?? RUNNING;
  }
}

/** Whether the indexer is paused, opening a short connection when the caller has none. */
export async function isPaused(env: Env, sql?: Sql): Promise<boolean> {
  if (cached && Date.now() - cached.at < PAUSE_CACHE_MS) return cached.state.paused;
  if (sql) return (await readPause(sql)).paused;
  const own = postgres(dbUrl(env), { max: 1, fetch_types: false, prepare: false });
  try {
    return (await readPause(own)).paused;
  } finally {
    await own.end({ timeout: 5 });
  }
}

/** Store the flag. Pausing twice keeps the first pausedAt. */
export async function writePause(sql: Sql, paused: boolean, reason: string | null = null): Promise<PauseState> {
  const now = new Date().toISOString();
  const prev = await readPause(sql, { fresh: true });
  const state: PauseState = paused
    ? { paused: true, pausedAt: prev.paused ? prev.pausedAt : now, resumedAt: prev.resumedAt, reason }
    : { paused: false, pausedAt: null, resumedAt: prev.paused ? now : prev.resumedAt, reason: null };
  await sql`insert into indexer_state (key, value) values ('paused', ${sql.json(state as never)})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
  cached = { at: Date.now(), state };
  return state;
}

/** The body of a 503 for work that needs the chain while paused. */
export const PAUSED_BODY = {
  error: { code: 'paused', message: 'Indexing is paused for now; data shown is the last indexed state. Try again later.' },
} as const;

/** Tests only: forget the cached flag. */
export function resetPauseCache(state?: PauseState) {
  cached = state ? { at: Date.now(), state } : null;
}

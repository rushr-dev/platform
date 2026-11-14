// On-demand signal refresh: a token that is viewed or quoted with signals older than SIGNALS_STALE_MS gets
// them recomputed in the background (after the response), at most once per REFRESH_DEBOUNCE_MS per token
// in each isolate. Quiet graduated tokens are otherwise only recomputed when they trade, so their signals
// read `stale` to agents. Inline rather than queued: the enrich queue can be hours deep after a backfill.
import postgres from 'postgres';
import { dbUrl, type Env } from './env';
import { Rpc } from './rpc';
import { recomputeSignals } from './signals';
import { isPaused } from './pause';

/** Same threshold as the agents API's `stale` flag. */
export const SIGNALS_STALE_MS = 10 * 60_000;
const REFRESH_DEBOUNCE_MS = 2 * 60_000;
const asked = new Map<string, number>();

/** Whether a refresh should start now (pure; exported for tests). */
export function shouldRefresh(token: string, updatedAt: Date | string | null | undefined, now = Date.now()): boolean {
  const at = updatedAt ? new Date(updatedAt).getTime() : 0;
  if (now - at < SIGNALS_STALE_MS) return false;
  if (now - (asked.get(token) ?? 0) < REFRESH_DEBOUNCE_MS) return false;
  if (asked.size > 5_000) asked.clear();
  asked.set(token, now);
  return true;
}

/** Recompute a token's signals after the response if they are stale (debounced). No-op without an execution context (tests). */
export function refreshSignalsIfStale(
  c: { env: Env; executionCtx: { waitUntil(p: Promise<unknown>): void } },
  token: string,
  updatedAt: Date | string | null | undefined,
) {
  let ctx: { waitUntil(p: Promise<unknown>): void };
  try {
    ctx = c.executionCtx;
  } catch {
    return;
  }
  const env = c.env;
  if (!/^0x[0-9a-f]{40}$/.test(token) || !shouldRefresh(token, updatedAt)) return;
  ctx.waitUntil(
    (async () => {
      const sql = postgres(dbUrl(env), { max: 1, fetch_types: false, prepare: false });
      try {
        if (await isPaused(env, sql)) return; // indexer switched off: no chain reads
        await recomputeSignals(sql, new Rpc(env.RPC_URL), token);
      } catch (err) {
        console.error('signal refresh failed', token, err);
      } finally {
        await sql.end({ timeout: 5 });
      }
    })(),
  );
}

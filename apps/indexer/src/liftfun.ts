import type { Sql } from 'postgres';

/**
 * lift.fun graduation and bonding progress.
 *
 * On Robinhood Chain a lift.fun token lives in one Uniswap v4 pool with the lift hook for its whole life:
 * there is no graduation event, migration or new pool. At the recorded graduation times the chain shows an
 * ordinary swap. The hook's getPool(poolId) state does not flag it either. lift.fun decides graduation in its
 * backend (`graduated`, `graduated_at`, `progress_bps` on its public token API), so that API is the source.
 * Only 5 of its 5,238 Robinhood launches had graduated as of 2026-11-13.
 */

export const LIFT_API = 'https://api.lift.fun/api/v1/tokens';
export const LIFT_CHAIN = 4663;

export interface LiftItem {
  chain_id: number;
  address: string;
  graduated: boolean;
  graduated_at: string | null;
  progress_bps: number;
}

export interface LiftUpdate {
  token: string;
  /** Set only when graduated: the on-chain time lift.fun recorded for it. */
  migratedAt: Date | null;
  /** 0..1; graduated = 1, otherwise capped below 1 (a curve at 100% that has not graduated yet). */
  progress: number;
}

/** What to write for one API item (null when it is not a Robinhood token or is malformed). */
export function liftUpdate(item: LiftItem): LiftUpdate | null {
  if (item.chain_id !== LIFT_CHAIN || !/^0x[0-9a-fA-F]{40}$/.test(item.address ?? '')) return null;
  const token = item.address.toLowerCase();
  if (item.graduated) {
    const at = item.graduated_at ? new Date(item.graduated_at) : null;
    return { token, migratedAt: at && !Number.isNaN(at.getTime()) ? at : null, progress: 1 };
  }
  const bps = Number(item.progress_bps);
  return { token, migratedAt: null, progress: Number.isFinite(bps) ? Math.min(Math.max(bps, 0) / 10_000, 0.999) : 0 };
}

async function get(url: string): Promise<{ items?: LiftItem[]; next_cursor?: string | null }> {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'rushr-indexer' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`lift.fun ${res.status}`);
  return res.json();
}

/** Every graduated lift.fun token on Robinhood Chain (paged by the API's cursor). */
export async function liftGraduated(): Promise<LiftUpdate[]> {
  const out: LiftUpdate[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < 20; page++) {
    const j = await get(`${LIFT_API}?chain=${LIFT_CHAIN}&graduated=true${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const it of j.items ?? []) {
      const u = liftUpdate(it);
      if (u?.migratedAt) out.push(u);
    }
    cursor = j.next_cursor;
    if (!cursor || !(j.items ?? []).length) break;
  }
  return out;
}

/** Mark graduated tokens migrated (only lift.fun tokens we track; returns the ones changed). */
export async function applyLiftGraduations(sql: Sql, grads: LiftUpdate[]): Promise<string[]> {
  const changed: string[] = [];
  for (const g of grads) {
    const rows = await sql<{ address: string }[]>`
      update tokens set status = 'migrated', bonding_progress = 1, migrated_at = ${g.migratedAt}, updated_at = now()
      where address = ${g.token} and launchpad = 'liftfun'
        and (status is distinct from 'migrated' or migrated_at is distinct from ${g.migratedAt} or bonding_progress is distinct from 1)
      returning address`;
    if (rows.length) changed.push(g.token);
  }
  return changed;
}

/**
 * Bonding progress (and graduation) for lift.fun tokens traded recently, one API lookup each. Bounded:
 * at most `max` tokens per run, oldest-updated first.
 */
export async function syncLiftProgress(sql: Sql, max = 25, windowMin = 30): Promise<{ checked: number; graduated: string[] }> {
  const tokens = await sql<{ address: string }[]>`
    select t.address from tokens t
    where t.launchpad = 'liftfun' and t.status is distinct from 'migrated'
      and exists (select 1 from swaps s where s.token = t.address and s.time > now() - ${windowMin} * interval '1 minute')
    order by t.updated_at nulls first limit ${max}`;
  const updates: LiftUpdate[] = [];
  for (let i = 0; i < tokens.length; i += 5) {
    const got = await Promise.all(
      tokens.slice(i, i + 5).map(async ({ address }) => {
        const j = await get(`${LIFT_API}?chain=${LIFT_CHAIN}&q=${address}`).catch(() => null);
        const item = j?.items?.find((x) => x.address?.toLowerCase() === address);
        return item ? liftUpdate(item) : null;
      }),
    );
    updates.push(...got.filter((u): u is LiftUpdate => !!u));
  }
  for (const u of updates.filter((x) => !x.migratedAt)) {
    await sql`update tokens set bonding_progress = ${u.progress} where address = ${u.token} and status is distinct from 'migrated'`;
  }
  const graduated = await applyLiftGraduations(sql, updates.filter((x) => x.migratedAt));
  return { checked: tokens.length, graduated };
}

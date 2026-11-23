import type { Sql } from 'postgres';

/**
 * QHooks launches (qhooks.com) in the trenches. New QHooks tokens are tagged on-chain from their pool's hook
 * (the core launchpad registry, id 'qhooks'); this sync adds what the chain alone doesn't say: bonding
 * progress (progressBps / targetBps) and whether a launch has bonded. It also tags tokens indexed before
 * QHooks was in the registry. Source: `list_launches` on QHooks' public MCP (no key).
 *
 * QHooks' docs ask agents not to poll `list_launches` on a timer; this runs every few minutes from the cron
 * while we agree a feed with them (QHOOKS_SYNC=0 turns it off).
 */

export const QHOOKS_MCP = 'https://qhooks.com/mcp';

export interface QHooksLaunch {
  chainId?: string;
  token?: string;
  poolId?: string;
  key?: { hooks?: string };
  progressBps?: number | null;
  targetBps?: number | null;
  bonded?: boolean;
  bondedAt?: string | number | null;
}

export interface QHooksUpdate {
  token: string;
  poolId: string | null;
  hook: string | null;
  /** 0..1 of the way to bonding; 1 once bonded. */
  progress: number;
  bonded: boolean;
  bondedAt: Date | null;
}

const ADDR = /^0x[0-9a-f]{40}$/;

/** One launch → one update, or null if it isn't a Robinhood Chain token we can use. */
export function qhooksUpdate(l: QHooksLaunch): QHooksUpdate | null {
  if (String(l.chainId) !== '4663') return null;
  const token = String(l.token ?? '').toLowerCase();
  if (!ADDR.test(token)) return null;
  const target = Number(l.targetBps);
  const at = Number(l.progressBps);
  const bonded = l.bonded === true;
  const progress = bonded ? 1 : target > 0 && Number.isFinite(at) ? Math.max(0, Math.min(1, at / target)) : 0;
  const when = l.bondedAt == null ? null : new Date(typeof l.bondedAt === 'number' && l.bondedAt < 1e12 ? l.bondedAt * 1000 : l.bondedAt);
  const poolId = /^0x[0-9a-f]{64}$/i.test(String(l.poolId ?? '')) ? String(l.poolId).toLowerCase() : null;
  const hook = ADDR.test(String(l.key?.hooks ?? '').toLowerCase()) ? String(l.key!.hooks).toLowerCase() : null;
  return { token, poolId, hook, progress, bonded, bondedAt: when && !Number.isNaN(when.getTime()) ? when : null };
}

export async function fetchQHooksLaunches(fetcher: typeof fetch = fetch): Promise<QHooksLaunch[]> {
  const r = await fetcher(QHOOKS_MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'X-QHooks-Client-Name': 'rushr' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'list_launches', method: 'tools/call', params: { name: 'list_launches', arguments: { chain: '4663', limit: 100 } } }),
  });
  if (!r.ok) throw new Error(`qhooks list_launches ${r.status}`);
  const b = (await r.json()) as { result?: { structuredContent?: { launches?: QHooksLaunch[] } } };
  return b.result?.structuredContent?.launches ?? [];
}

/**
 * Tags the tokens and launch pools, and sets progress / bonded. Only tokens we already index are touched
 * (the poller finds new ones on-chain). Returns how many tokens changed, and hooks not in the registry yet.
 */
export async function applyQHooks(sql: Sql, launches: QHooksLaunch[], knownHooks: readonly string[]): Promise<{ changed: number; newHooks: string[] }> {
  const ups = launches.map(qhooksUpdate).filter((u): u is QHooksUpdate => u != null);
  let changed = 0;
  for (const u of ups) {
    const res = await sql`
      update tokens set launchpad = 'qhooks', bonding_progress = ${u.progress},
        status = case when ${u.bonded} then 'migrated' else status end,
        migrated_at = case when ${u.bonded} then coalesce(migrated_at, ${u.bondedAt}, now()) else migrated_at end,
        updated_at = now()
      where address = ${u.token}
        and (launchpad is distinct from 'qhooks' or bonding_progress is distinct from ${u.progress}
             or (${u.bonded} and status is distinct from 'migrated'))`;
    changed += res.count;
    if (u.poolId) await sql`update pools set launchpad = 'qhooks' where id = ${u.poolId} and launchpad is distinct from 'qhooks'`;
  }
  const known = new Set(knownHooks.map((h) => h.toLowerCase()));
  const newHooks = [...new Set(ups.map((u) => u.hook).filter((h): h is string => !!h && !known.has(h)))];
  return { changed, newHooks };
}

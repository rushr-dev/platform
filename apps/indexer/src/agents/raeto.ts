// Raeto account records: an agent that runs its AI on Raeto (raeto.cc) can link its record, an ERC-8004 agent id
// on Robinhood Chain. Rushr reads it from Raeto's public API (no key needed) and shows "On record" next to the
// agent's "Runs on Raeto" label while Raeto reports the record as active.
import type { Sql } from 'postgres';

export const RAETO_API = 'https://api.raeto.cc/v1';
/** Raeto's public page for an agent's record. */
export const raetoRecordUrl = (agentId: string) => `https://raeto.cc/a/${agentId}`;

export interface RaetoRecord {
  agentId: string;
  /** The record's name: the tag the agent sends on its calls (X-Raeto-Agent). */
  name: string | null;
  /** 'active' means on record. */
  status: string;
  /** The agent's Raeto account and the wallet that owns its record. */
  account: string | null;
  owner: string | null;
}

/** The record for an ERC-8004 agent id, or null when Raeto has none. Throws when Raeto can't be reached. */
export async function fetchRaetoRecord(agentId: string): Promise<RaetoRecord | null> {
  const r = await fetch(`${RAETO_API}/statements/agents/${encodeURIComponent(agentId)}`, {
    headers: { accept: 'application/json', 'user-agent': 'rushr-indexer (+https://rushr.trade)' },
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`raeto ${r.status}`);
  const j = (await r.json()) as { agent_id?: unknown; name?: unknown; status?: unknown; account?: unknown; owner?: unknown };
  const s = (v: unknown) => (typeof v === 'string' && v ? v : null);
  return { agentId: s(j.agent_id) ?? agentId, name: s(j.name), status: s(j.status) ?? 'unknown', account: s(j.account), owner: s(j.owner) };
}

/**
 * Is this record the agent's own? Its name must be the agent's Rushr handle (the tag our example agents send),
 * or the record must belong to the agent's wallet. Stops one agent from showing another agent's record.
 */
export function recordIsAgents(rec: RaetoRecord, m: { handle: string; wallet: string | null }): boolean {
  const w = m.wallet?.toLowerCase();
  if (rec.name && rec.name.toLowerCase() === m.handle.toLowerCase()) return true;
  return Boolean(w && (rec.account?.toLowerCase() === w || rec.owner?.toLowerCase() === w));
}

/** The status we store: Raeto's, or 'none' (record gone) / 'mismatch' (no longer the agent's). */
export const storedStatus = (rec: RaetoRecord | null, m: { handle: string; wallet: string | null }) =>
  !rec ? 'none' : recordIsAgents(rec, m) ? rec.status : 'mismatch';

/** The public `runsOn` field, from a member row. */
export function runsOnOf(m: { runs_on: string | null; runs_on_url: string | null; runs_on_agent_id?: string | null; runs_on_status?: string | null }) {
  if (!m.runs_on) return null;
  const agentId = m.runs_on_agent_id ?? null;
  return {
    provider: m.runs_on,
    // A linked record links to its page on Raeto; otherwise the agent's own statement link, if any.
    url: agentId ? raetoRecordUrl(agentId) : m.runs_on_url,
    agentId,
    /** Checked against Raeto's API: the record exists, is the agent's own and is active. */
    onRecord: Boolean(agentId) && m.runs_on_status === 'active',
  };
}

/** Cron: re-read linked records not checked in the last 30 minutes. Returns how many changed status. */
export async function refreshRaetoRecords(sql: Sql, limit = 50): Promise<number> {
  const rows = await sql<{ id: string; handle: string; wallet: string | null; runs_on_agent_id: string; runs_on_status: string | null }[]>`
    select id, handle, wallet, runs_on_agent_id, runs_on_status from members
    where runs_on_agent_id is not null and (runs_on_checked_at is null or runs_on_checked_at < now() - interval '30 minutes')
    order by runs_on_checked_at nulls first limit ${limit}`;
  let changed = 0;
  for (const m of rows) {
    let status: string;
    try {
      status = storedStatus(await fetchRaetoRecord(m.runs_on_agent_id), m);
    } catch {
      continue; // Raeto unreachable: keep the last known status and try next round
    }
    if (status !== m.runs_on_status) changed++;
    await sql`update members set runs_on_status = ${status}, runs_on_checked_at = now() where id = ${m.id}`;
  }
  return changed;
}

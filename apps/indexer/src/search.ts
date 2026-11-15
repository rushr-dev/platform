// Token search: the real token first, not the farm copies.
//
// Ordering by market cap put airdrop-farm copies on top (their market cap is fake) and hid the real
// token. Now: an exact address, then exact-symbol matches, then symbol-prefix, then name matches. Inside
// each group a token that graduated from a launchpad curve leads (copies launch straight onto a plain pool,
// so they never migrate), spam and copycats sink, and the rest is ordered by organic holders (holders
// minus airdropped), then liquidity, then 24h volume.
import type { Sql } from 'postgres';

export interface SearchCandidate {
  address: string;
  symbol: string;
  name: string;
  status: string | null;
  holders: number | null;
  airdropped: number | null;
  spam: boolean | null;
  copycat: boolean | null;
  liquidity_usd: number | null;
  volume_24h_usd: number | null;
}

const MATCH_LIMIT = 500;

function group(c: SearchCandidate, q: string): number {
  const lq = q.toLowerCase();
  if (c.address === lq) return 0;
  const sym = (c.symbol ?? '').toLowerCase();
  if (sym === lq) return 1;
  if (sym.startsWith(lq)) return 2;
  return 3;
}

const organic = (c: SearchCandidate) => Math.max(0, (c.holders ?? 0) - (c.airdropped ?? 0));

/** Order search candidates (pure; see the header). */
export function rankSearch(rows: SearchCandidate[], q: string, limit = 20): SearchCandidate[] {
  const key = (c: SearchCandidate) => [
    group(c, q),
    c.status === 'migrated' ? 0 : 1,
    c.spam || c.copycat ? 1 : 0,
    -organic(c),
    -(c.liquidity_usd ?? 0),
    -(c.volume_24h_usd ?? 0),
  ];
  return [...rows]
    .map((c) => ({ c, k: key(c) }))
    .sort((a, b) => {
      for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return a.k[i]! - b.k[i]!;
      return 0;
    })
    .slice(0, limit)
    .map((x) => x.c);
}

/** Search by address, symbol (prefix) or name (substring). Returns addresses, best first. */
export async function searchTokens(sql: Sql, q: string, limit = 20): Promise<string[]> {
  const lq = q.toLowerCase();
  const rows = await sql<SearchCandidate[]>`
    select t.address, t.symbol, t.name, t.status, t.holders,
      (s.data->>'airdroppedHolders')::int as airdropped, (s.data->>'spam')::bool as spam, (s.data->>'copycat')::bool as copycat,
      t.liquidity_usd::float8 as liquidity_usd, t.volume_24h_usd::float8 as volume_24h_usd
    from tokens t left join signals s on s.token = t.address
    where t.address = ${lq} or t.symbol ilike ${q + '%'} or t.name ilike ${'%' + q + '%'}
    order by (t.address = ${lq}) desc, (lower(t.symbol) = ${lq}) desc, (t.status = 'migrated') desc, t.holders desc nulls last
    limit ${MATCH_LIMIT}`;
  return rankSearch(rows, q, limit).map((r) => r.address);
}

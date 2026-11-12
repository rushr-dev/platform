'use client';

import { useEffect, useState } from 'react';
import { API_URL } from './api';
import type { Pair } from './pairs';

/**
 * A token's pools: Rushr's own `/tokens/:a/pools` first, DexScreener for anything it doesn't have.
 *
 * Works before and after that endpoint ships: a 404 (route not deployed yet), an error or an
 * empty list all mean "use DexScreener only", exactly as before. Once it's live, our rows win and
 * DexScreener only fills a null liquidity (v4 pools, for now) and adds venues we don't index.
 */

/** Row from `GET /tokens/:a/pools` (Data stream). Every field is optional so older shapes don't break us. */
export interface ApiPool {
  pool: string;
  dex?: string | null;
  version?: 'v4' | 'v3' | 'v2' | 'curve' | string | null;
  launchpad?: string | null;
  quote?: string | null;
  liquidity_usd?: number | null;
  liquidity_at?: string | null;
  volume_24h_usd?: number | null;
  trades_24h?: number | null;
  created_at?: string | null;
}

export interface PoolRow {
  id: string;
  dex: string;
  version: string | null;
  quote: string;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  url: string;
  /** Where the liquidity figure came from (null when nobody has one). */
  liquidityFrom: 'rushr' | 'dexscreener' | null;
  /** True for venues only DexScreener knows about. */
  external: boolean;
}

/** `undefined` while loading, `null` when the endpoint isn't available, else the rows. */
export function useApiPools(address: string): ApiPool[] | null | undefined {
  const [pools, setPools] = useState<ApiPool[] | null | undefined>(undefined);
  useEffect(() => {
    let ctl = new AbortController();
    const run = () =>
      fetch(`${API_URL}/tokens/${address}/pools`, { signal: ctl.signal })
        .then(async (r) => {
          if (!r.ok) {
            await r.body?.cancel();
            return null;
          }
          const body = (await r.json()) as { pools?: ApiPool[] };
          return Array.isArray(body.pools) ? body.pools.filter((p) => p && typeof p.pool === 'string') : null;
        })
        .then(setPools)
        .catch((e: Error) => e.name !== 'AbortError' && setPools((p) => p ?? null));
    void run();
    // The API refreshes v3/v2 balances at most every 30s.
    const id = setInterval(() => {
      ctl = new AbortController();
      void run();
    }, 30_000);
    return () => {
      clearInterval(id);
      ctl.abort();
    };
  }, [address]);
  return pools;
}

const dsUrl = (pool: string) => `https://dexscreener.com/robinhood/${pool.toLowerCase()}`;

export function mergePools(
  api: ApiPool[] | null | undefined,
  ds: Pair[] | null,
  quoteLabel: (q: string | null | undefined) => string,
): { rows: PoolRow[]; liquidityUsd: number | null; loading: boolean; source: 'rushr' | 'dexscreener' | 'mixed' | null } {
  const fromDs = (p: Pair): PoolRow => ({
    id: p.pairAddress.toLowerCase(),
    dex: p.dex,
    version: p.version,
    quote: p.quote,
    liquidityUsd: p.liquidityUsd,
    volume24hUsd: p.volume.h24 ?? null,
    url: p.url,
    liquidityFrom: p.liquidityUsd != null ? 'dexscreener' : null,
    external: true,
  });
  const loading = api === undefined && ds == null;
  let rows: PoolRow[];
  if (api?.length) {
    const byId = new Map((ds ?? []).map((p) => [p.pairAddress.toLowerCase(), p]));
    const used = new Set<string>();
    rows = api.map((p) => {
      const id = p.pool.toLowerCase();
      const match = byId.get(id);
      if (match) used.add(id);
      const ours = p.liquidity_usd ?? null;
      const liq = ours ?? match?.liquidityUsd ?? null;
      return {
        id,
        dex: p.dex ?? match?.dex ?? 'pool',
        version: p.version ?? match?.version ?? null,
        quote: p.quote ? quoteLabel(p.quote) : (match?.quote ?? '—'),
        liquidityUsd: liq,
        volume24hUsd: p.volume_24h_usd ?? match?.volume.h24 ?? null,
        url: match?.url ?? dsUrl(id),
        liquidityFrom: ours != null ? 'rushr' : liq != null ? 'dexscreener' : null,
        external: false,
      };
    });
    const extra = (ds ?? []).filter((p) => !used.has(p.pairAddress.toLowerCase())).map(fromDs);
    rows = [...rows, ...extra];
  } else {
    rows = (ds ?? []).map(fromDs);
  }
  const measured = rows.filter((r) => r.liquidityUsd != null);
  const liquidityUsd = measured.length ? measured.reduce((t, r) => t + r.liquidityUsd!, 0) : null;
  const froms = new Set(measured.map((r) => r.liquidityFrom));
  const source = !measured.length ? null : froms.size > 1 ? 'mixed' : froms.has('rushr') ? 'rushr' : 'dexscreener';
  return { rows, liquidityUsd, loading, source };
}

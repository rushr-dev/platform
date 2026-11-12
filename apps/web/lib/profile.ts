'use client';

import { useEffect, useState } from 'react';
import { API_URL } from './api';
import { V1, type Member } from './members';

/**
 * Profile data: the member (Agents API, /v1/members/:handle) and wallet PnL (Data API,
 * /wallets/:w/pnl). Both degrade to `unavailable` until their endpoints answer.
 */

export interface PnlSummary {
  realized_usd: number | null;
  unrealized_usd: number | null;
  realized_24h_usd: number | null;
  realized_7d_usd: number | null;
  realized_30d_usd: number | null;
  volume_usd: number | null;
  trades: number | null;
  tokens_traded: number | null;
  win_rate: number | null;
  best_trade_usd: number | null;
  last_trade_at: string | null;
}

export interface Position {
  token: string;
  symbol: string;
  name: string;
  image_url: string | null;
  price_usd: number | null;
  bought_usd: number;
  sold_usd: number;
  buys: number;
  sells: number;
  held_tokens: string;
  cost_basis_usd: number;
  realized_usd: number;
  unrealized_usd: number;
  first_trade_at: string | null;
  last_trade_at: string | null;
}

export type Loadable<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'unavailable' };

function useJson<T>(url: string | null, pick: (body: unknown) => T | null, refreshMs = 0): Loadable<T> {
  const [v, setV] = useState<Loadable<T>>({ state: 'loading' });
  useEffect(() => {
    if (!url) return setV({ state: 'unavailable' });
    let live = true;
    const ctl = new AbortController();
    const run = () =>
      fetch(url, { signal: ctl.signal })
        .then(async (r) => {
          const ct = r.headers.get('content-type') ?? '';
          if (!r.ok || !ct.includes('json')) {
            await r.body?.cancel();
            throw new Error(String(r.status));
          }
          const data = pick(await r.json());
          if (live) setV(data == null ? { state: 'unavailable' } : { state: 'ready', data });
        })
        .catch((e: Error) => live && e.name !== 'AbortError' && setV((p) => (p.state === 'ready' ? p : { state: 'unavailable' })));
    setV({ state: 'loading' });
    void run();
    const id = refreshMs ? setInterval(run, refreshMs) : undefined;
    return () => {
      live = false;
      ctl.abort();
      clearInterval(id);
    };
  }, [url, refreshMs]);
  return v;
}

export function useMember(handle: string | null): Loadable<Member> {
  return useJson(handle ? `${V1}/members/${encodeURIComponent(handle)}` : null, (b) => (b as { member?: Member })?.member ?? null);
}

export function useWalletPnl(wallet: string | null): Loadable<{ summary: PnlSummary | null; positions: Position[] }> {
  return useJson(
    wallet ? `${API_URL}/wallets/${wallet.toLowerCase()}/pnl` : null,
    (b) => {
      const body = b as { summary?: PnlSummary | null; positions?: Position[] } | null;
      return body && Array.isArray(body.positions) ? { summary: body.summary ?? null, positions: body.positions } : null;
    },
    30_000,
  );
}

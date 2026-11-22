'use client';

import { useEffect, useState } from 'react';
import { API_URL } from './api';

/** A FOMO thesis or large FOMO trade on a token (indexer /tokens/:address/fomo, from fomoapi.io). */
export interface FomoMark {
  id: string;
  kind: 'thesis' | 'buy' | 'sell';
  handle: string;
  avatarUrl: string | null;
  body: string | null;
  /** Buy: position size in USD. Sell: FOMO's realized PnL in USD (can be negative). Thesis: null. */
  usd: number | null;
  ts: string;
}

/** FOMO activity on one token, newest first, refreshed every minute. null while loading. */
export function useTokenFomo(token: string): FomoMark[] | null {
  const [items, setItems] = useState<FomoMark[] | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    const run = () =>
      fetch(`${API_URL}/tokens/${token.toLowerCase()}/fomo`, { signal: ctl.signal })
        .then((r) => (r.ok ? (r.json() as Promise<{ items: FomoMark[] }>) : null))
        .then((b) => setItems(b?.items ?? []))
        .catch(() => undefined);
    void run();
    const id = setInterval(run, 60_000);
    return () => {
      ctl.abort();
      clearInterval(id);
    };
  }, [token]);
  return items;
}

'use client';

import { useEffect, useState } from 'react';

/**
 * Pools for a token from DexScreener's public API, read in the browser. Our indexer only sees
 * Uniswap v4 and launchpad curves today and has no liquidity figure, so the pool panel and the
 * "all venues" numbers come from here until the API serves them (see Requests in docs/team-plan.md).
 */

export interface Pair {
  dex: string;
  version: string | null;
  pairAddress: string;
  url: string;
  quote: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  liquidityBase: number | null;
  liquidityQuote: number | null;
  volume: Partial<Record<Window, number>>;
  txns: Partial<Record<Window, { buys: number; sells: number }>>;
  priceChange: Partial<Record<Window, number>>;
  createdAt: number | null;
}

export type Window = 'm5' | 'h1' | 'h6' | 'h24';

interface DsPair {
  chainId: string;
  dexId: string;
  labels?: string[];
  url: string;
  pairAddress: string;
  baseToken: { address: string };
  quoteToken: { symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: Partial<Record<Window, number>>;
  txns?: Partial<Record<Window, { buys: number; sells: number }>>;
  priceChange?: Partial<Record<Window, number>>;
  pairCreatedAt?: number;
}

const cache = new Map<string, { at: number; pairs: Pair[] }>();

async function load(address: string, signal: AbortSignal): Promise<Pair[]> {
  const hit = cache.get(address);
  if (hit && Date.now() - hit.at < 30_000) return hit.pairs;
  const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { signal });
  if (!res.ok) throw new Error(String(res.status));
  const body = (await res.json()) as { pairs?: DsPair[] | null };
  const pairs = (body.pairs ?? [])
    .filter((p) => p.chainId === 'robinhood' && p.baseToken.address.toLowerCase() === address)
    .map<Pair>((p) => ({
      dex: p.dexId,
      version: p.labels?.[0] ?? null,
      pairAddress: p.pairAddress,
      url: p.url,
      quote: p.quoteToken.symbol,
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      liquidityUsd: p.liquidity?.usd ?? null,
      liquidityBase: p.liquidity?.base ?? null,
      liquidityQuote: p.liquidity?.quote ?? null,
      volume: p.volume ?? {},
      txns: p.txns ?? {},
      priceChange: p.priceChange ?? {},
      createdAt: p.pairCreatedAt ?? null,
    }))
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
  cache.set(address, { at: Date.now(), pairs });
  return pairs;
}

/** Pairs for the token, refreshed every 30s. `null` while loading, `[]` when DexScreener has none. */
export function usePairs(address: string): Pair[] | null {
  const [pairs, setPairs] = useState<Pair[] | null>(() => cache.get(address)?.pairs ?? null);
  useEffect(() => {
    let ctl = new AbortController();
    const run = () =>
      load(address, ctl.signal)
        .then(setPairs)
        .catch((e: Error) => e.name !== 'AbortError' && setPairs((p) => p ?? []));
    void run();
    const id = setInterval(() => {
      ctl = new AbortController();
      void run();
    }, 30_000);
    return () => {
      clearInterval(id);
      ctl.abort();
    };
  }, [address]);
  return pairs;
}

/** All venues summed: liquidity, volume and buy/sell counts per window. */
export function aggregate(pairs: Pair[]) {
  const sum = (f: (p: Pair) => number | undefined | null) => pairs.reduce((t, p) => t + (f(p) ?? 0), 0);
  const windows: Window[] = ['m5', 'h1', 'h6', 'h24'];
  const deepest = pairs[0];
  return {
    liquidityUsd: sum((p) => p.liquidityUsd),
    byWindow: Object.fromEntries(
      windows.map((w) => [
        w,
        {
          volume: sum((p) => p.volume[w]),
          buys: sum((p) => p.txns[w]?.buys),
          sells: sum((p) => p.txns[w]?.sells),
          change: deepest?.priceChange[w] ?? null,
        },
      ]),
    ) as Record<Window, { volume: number; buys: number; sells: number; change: number | null }>,
  };
}

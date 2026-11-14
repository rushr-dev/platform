'use client';

import { useEffect, useState } from 'react';
import { API_URL, type TokenCard } from './api';

/** Token search by symbol, name or contract (GET /search), debounced; empty below two characters. */
export function useTokenSearch(q: string): TokenCard[] {
  const [results, setResults] = useState<TokenCard[]>([]);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setResults([]);
    const ctl = new AbortController();
    const t = setTimeout(() => {
      fetch(`${API_URL}/search?q=${encodeURIComponent(term)}`, { signal: ctl.signal })
        .then((r) => r.json() as Promise<{ tokens: TokenCard[] }>)
        .then((d) => setResults(d.tokens ?? []))
        .catch(() => undefined);
    }, 120);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);
  return results;
}

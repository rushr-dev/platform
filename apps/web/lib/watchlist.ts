'use client';

import { useSyncExternalStore } from 'react';

/**
 * The watchlist: token addresses starred on their token page, shown as a ticker bar under the top bar.
 * Kept in this browser for the beta, like trade settings (lib/settings.ts); account sync can replace the
 * storage later without touching callers. Newest first, capped at MAX.
 */

const KEY = 'rushr.watchlist';
const MAX = 30;
const EMPTY: string[] = [];
const listeners = new Set<() => void>();
let cached: string[] | null = null;

function read(): string[] {
  if (cached) return cached;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    cached = Array.isArray(raw) ? raw.filter((a): a is string => typeof a === 'string' && /^0x[0-9a-f]{40}$/.test(a)).slice(0, MAX) : [];
  } catch {
    cached = [];
  }
  return cached;
}

function write(next: string[]) {
  cached = next.slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(cached));
  } catch {
    // Storage blocked (private mode): the list still works for this page view.
  }
  for (const l of listeners) l();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  // Another tab changed the list.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    cached = null;
    fn();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

/** Watched token addresses (lowercase), newest first. Empty during server render. */
export function useWatchlist(): string[] {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export function toggleWatch(address: string) {
  const a = address.toLowerCase();
  const list = read();
  write(list.includes(a) ? list.filter((x) => x !== a) : [a, ...list]);
}

'use client';

import { useSyncExternalStore } from 'react';

/**
 * One shared clock per tab. Components that show "time ago" read it through `useNow`, so only
 * they re-render each second, not the whole page around them.
 */
let now = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

function start() {
  now = Date.now();
  timer = setInterval(() => {
    now = Date.now();
    listeners.forEach((l) => l());
  }, 1000);
}

function sub(cb: () => void) {
  listeners.add(cb);
  if (!timer) start();
  return () => {
    listeners.delete(cb);
    if (!listeners.size) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

/** Current time in ms, ticking every second. `serverNow` keeps the first render equal to the HTML. */
export function useNow(serverNow: number): number {
  return useSyncExternalStore(sub, () => now || serverNow, () => serverNow);
}

'use client';

import { useEffect, useState } from 'react';
import { API_URL } from './api';

export interface RushLive {
  name: string;
  endsAt: string;
  prizeUsd: number;
}

let cached: Promise<RushLive | null> | null = null;

/** Reads GET /v1/events/rush once per page load: the event while it is live, else null. */
function load(): Promise<RushLive | null> {
  cached ??= fetch(`${API_URL}/v1/events/rush`)
    .then((r) => (r.ok ? (r.json() as Promise<{ event?: Record<string, unknown> } & Record<string, unknown>>) : null))
    .then((j) => {
      const e = (j?.event ?? j) as { status?: string; endsAt?: string; name?: string; prizes?: Record<string, unknown> } | null;
      if (!e || e.status !== 'live' || !e.endsAt || Date.parse(e.endsAt) <= Date.now()) return null;
      const p = (e.prizes ?? {}) as Record<string, unknown>;
      const prizeUsd = Object.values(p).reduce<number>((a, v) => a + (typeof v === 'number' ? v : 0), 0);
      return { name: e.name ?? 'Rush the Trenches', endsAt: e.endsAt, prizeUsd };
    })
    .catch(() => null);
  return cached;
}

/** Rush the Trenches while it is live (for the nav dot and the Trenches banner); null otherwise or while loading. */
export function useRushLive(): RushLive | null {
  const [live, setLive] = useState<RushLive | null>(null);
  useEffect(() => {
    let on = true;
    void load().then((v) => on && setLive(v));
    return () => {
      on = false;
    };
  }, []);
  return live;
}

/** "1d 4h" / "6h" / "45m" until a time. */
export function timeLeft(iso: string, now = Date.now()): string {
  const m = Math.max(0, Math.floor((Date.parse(iso) - now) / 60_000));
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h`;
  return `${m % 60}m`;
}

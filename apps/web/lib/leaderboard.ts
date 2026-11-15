'use client';

import { useEffect, useState } from 'react';
import { V1 } from './members';

/**
 * The leaderboard (GET /v1/leaderboard, apps/indexer/src/agents/board.ts): registered members ranked by
 * on-chain PnL, for the running season or a rolling window, across everyone, humans or agents.
 * While the API has the feature switched off it answers `feature_disabled`; callers show an
 * "Opening soon" state for that instead of an error.
 */

export type BoardWindow = 'season' | '24h' | '7d' | '30d';
export type BoardKind = 'all' | 'human' | 'agent';

export interface Season {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string;
}

export interface BoardMember {
  id: string;
  handle: string;
  kind: 'human' | 'agent';
  wallet: string;
  displayName: string | null;
  avatarUrl: string | null;
  owner: { id: string; handle: string } | null;
}

export interface BoardRow {
  rank: number;
  member: BoardMember;
  score: number | null;
  pnl: number | null;
  realized: number | null;
  unrealized: number | null;
  /** Return on what was put in, as a fraction (0.12 = +12%). */
  roi: number | null;
  volumeUsd: number | null;
  trades: number;
  tokens: number;
  /** Share of traded tokens closed in profit, as a fraction. */
  winRate: number | null;
  inclAgents: boolean;
  agentsPnl: number | null;
  agents: { id: string; handle: string }[];
}

export interface Board {
  window: BoardWindow;
  season: Season | null;
  from: string;
  to: string;
  final: boolean;
  rows: BoardRow[];
}

export interface MyRank {
  rank: number | null;
  humanRank?: number | null;
  agentRank?: number | null;
  score: number | null;
  pnl: number | null;
  unranked: string | null;
}

/** `ready` with data, `off` while the API has the feature switched off, `none` when no season exists yet. */
export type Load<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'off' } | { state: 'none' } | { state: 'error' };

async function read<T>(path: string, signal: AbortSignal): Promise<Load<T>> {
  try {
    const r = await fetch(`${V1}${path}`, { signal });
    if (r.ok) return { state: 'ready', data: (await r.json()) as T };
    const body = (await r.json().catch(() => null)) as { error?: { code?: string } } | null;
    const code = body?.error?.code;
    if (code === 'feature_disabled') return { state: 'off' };
    if (code === 'no_season') return { state: 'none' };
    return { state: 'error' };
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { state: 'loading' };
    return { state: 'error' };
  }
}

/** Reads `path` (relative to /v1) whenever it changes; null path = nothing to read. */
export function useV1<T>(path: string | null): Load<T> {
  const [res, setRes] = useState<{ path: string | null; load: Load<T> }>({ path: null, load: { state: 'loading' } });
  useEffect(() => {
    if (!path) return;
    const ctl = new AbortController();
    void read<T>(path, ctl.signal).then((load) => !ctl.signal.aborted && setRes({ path, load }));
    return () => ctl.abort();
  }, [path]);
  return path && res.path === path ? res.load : { state: 'loading' };
}

export const boardPath = (window: BoardWindow, kind: BoardKind, limit = 100) => `/leaderboard?window=${window}&kind=${kind}&limit=${limit}`;
export const rankPath = (handle: string, window: BoardWindow) => `/members/${encodeURIComponent(handle)}/rank?window=${window}`;

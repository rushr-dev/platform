'use client';

import { useEffect, useState } from 'react';

/**
 * What we last knew about the signed-in user (wallet, display name, member record), kept in this
 * browser so a refresh paints the user's bits at once instead of waiting for the auth SDK to load
 * and /v1/me to answer. It is only a hint for display and public reads: anything that needs auth
 * still waits for the real session, and the hint is replaced as soon as fresh data arrives and
 * cleared when the session turns out to be signed out.
 */

const KEY = 'rushr.session.v1';
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;

export interface SessionHint {
  wallet: string | null;
  name: string | null;
  /** The last /v1/me answer (same shape as lib/members MeResult). */
  me: unknown;
  at: number;
}

export function readHint(): SessionHint | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as SessionHint | null;
    if (!v || Date.now() - v.at > MAX_AGE_MS) return null;
    return v;
  } catch {
    return null;
  }
}

export function writeHint(patch: Partial<Omit<SessionHint, 'at'>>) {
  try {
    const cur = readHint() ?? { wallet: null, name: null, me: null, at: 0 };
    localStorage.setItem(KEY, JSON.stringify({ ...cur, ...patch, at: Date.now() }));
  } catch {
    // storage unavailable: the page just paints a little later
  }
}

export function clearHint() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage unavailable
  }
}

/** The hint, read after mount: undefined until read (server render, first paint), null when none. */
export function useHint(): SessionHint | null | undefined {
  const [h, setH] = useState<SessionHint | null | undefined>(undefined);
  useEffect(() => setH(readHint()), []);
  return h;
}

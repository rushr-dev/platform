'use client';

import { useEffect, useState } from 'react';
import { authed, V1 } from './members';

/**
 * Referral links: app.rushr.trade/?ref=<handle> (any page). The code is the referrer's handle. We keep it until
 * sign-up sends it: sessionStorage for the tab, plus a localStorage copy for 30 days, so someone who looks around
 * first and signs up a few days later still counts. First touch wins: a later ?ref= never replaces a stored one.
 * The API records it once, at sign-up, and it never changes after that (indexer agents/referrals.ts).
 */

const KEY = 'rushr.ref';
const TTL_MS = 30 * 24 * 3600 * 1000;
export const REF_RE = /^[a-z0-9_]{3,20}$/;

/** "@Rein " → "rein"; null when it can't be a handle. */
export function normalizeRef(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim().replace(/^@/, '').toLowerCase();
  return REF_RE.test(s) ? s : null;
}

export function captureReferralFromUrl() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('ref')) return;
    const code = normalizeRef(url.searchParams.get('ref'));
    if (code && !storedReferral()) {
      sessionStorage.setItem(KEY, code);
      localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() }));
    }
    // Keep the address bar clean (and shared links free of someone else's code).
    url.searchParams.delete('ref');
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  } catch {
    // storage unavailable: the user can still type the handle at sign-up
  }
}

export function storedReferral(): string | null {
  try {
    const s = normalizeRef(sessionStorage.getItem(KEY));
    if (s) return s;
    const l = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { code?: string; at?: number } | null;
    const code = normalizeRef(l?.code);
    if (code && Date.now() - (l?.at ?? 0) < TTL_MS) return code;
  } catch {
    // ignore
  }
  return null;
}

export function clearReferral() {
  try {
    sessionStorage.removeItem(KEY);
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

/** GET /v1/referrals/:code. The referrer's handle when the code is a member, false when it isn't, null when unknown. */
export async function checkReferral(code: string): Promise<string | false | null> {
  try {
    const r = await fetch(`${V1}/referrals/${encodeURIComponent(code)}`);
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    const b = (await r.json()) as { valid?: boolean; referrer?: { handle: string } | null };
    return b.valid && b.referrer ? b.referrer.handle : false;
  } catch {
    return null;
  }
}

/** GET /v1/me/referrals. */
export interface Referrals {
  code: string;
  link: string;
  discountBps: number;
  shareBps: number;
  joined: number;
  traded: number;
  trades: number;
  referees: { handle: string; kind: 'human' | 'agent'; joinedAt: string }[];
  earned: { fee_token: string; amount: string }[];
  usd: { ethUsd: number | null; earned: number | null };
  payout: { schedule: 'weekly'; next: string; weekday: string };
}

export function useReferrals(enabled: boolean): { data: Referrals | null; state: 'loading' | 'ready' | 'unavailable' } {
  const [data, setData] = useState<Referrals | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void authed('/me/referrals')
      .then(async (r) => {
        if (!live) return;
        if (!r.ok) {
          await r.body?.cancel();
          return setState('unavailable');
        }
        setData((await r.json()) as Referrals);
        setState('ready');
      })
      .catch(() => live && setState('unavailable'));
    return () => {
      live = false;
    };
  }, [enabled]);
  return { data, state };
}

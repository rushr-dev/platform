'use client';

import { useEffect, useState } from 'react';
import { auth } from './auth';
import { V1 } from './members';

/**
 * Calls (callouts): members' public takes on a token, from the API's /v1 social routes
 * (apps/indexer/src/agents/social.ts). Reading is public; posting, liking and commenting need a
 * registered member.
 */

export interface Callout {
  id: string;
  createdAt: string;
  author: {
    id: string;
    handle: string;
    kind: 'human' | 'agent';
    displayName: string | null;
    avatarUrl: string | null;
    owner: { id: string; handle: string } | null;
  };
  token: { address: string; symbol: string | null; name: string | null; imageUrl: string | null };
  stance: 'bullish' | 'bearish';
  body: string;
  atPost: { priceUsd: number | null; marketCapUsd: number | null };
  /** The author's buy linked to the call: made before posting, or within a short window after. */
  entry: { tx: string; time: string; priceUsd: number | null; usd: number | null; when: 'before_post' | 'after_post' } | null;
  result: { priceUsd: number | null; sincePostPct: number | null; sinceEntryPct: number | null; peakSincePostPct: number | null };
  likes: number;
  comments: number;
}

export interface CalloutComment {
  id: string;
  createdAt: string;
  body: string;
  author: { handle: string; kind: 'human' | 'agent'; displayName: string | null; avatarUrl: string | null };
}

/** Posting limits enforced by the API. */
export const CALL_MAX = 500;
export const COMMENT_MAX = 300;

/** Fired after this browser posts a call, so lists refresh right away. */
export const CALL_POSTED = 'rushr:call-posted';

async function authHeaders(): Promise<Record<string, string>> {
  const token = await auth.getAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function errorOf(r: Response, fallback: string) {
  const e = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
  return e?.error?.message ?? fallback;
}

/** A token's calls, newest first; polled every 10s and refreshed when this browser posts one. */
export function useTokenCallouts(token: string, limit = 50): { items: Callout[] | null; refresh: () => void } {
  const [items, setItems] = useState<Callout[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    const run = () =>
      fetch(`${V1}/tokens/${token.toLowerCase()}/callouts?limit=${limit}&r=${Date.now()}`, { signal: ctl.signal })
        .then((r) => (r.ok ? (r.json() as Promise<{ items: Callout[] }>) : null))
        .then((b) => b && setItems(b.items ?? []))
        .catch(() => undefined);
    void run();
    const id = setInterval(run, 10_000);
    const onPosted = () => void run();
    window.addEventListener(CALL_POSTED, onPosted);
    return () => {
      ctl.abort();
      clearInterval(id);
      window.removeEventListener(CALL_POSTED, onPosted);
    };
  }, [token, limit, tick]);
  return { items, refresh: () => setTick((x) => x + 1) };
}

export async function postCallout(input: { token: string; stance: 'bullish' | 'bearish'; body: string }): Promise<{ ok: true; callout: Callout } | { ok: false; message: string }> {
  try {
    const r = await fetch(`${V1}/callouts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(input),
    });
    if (!r.ok) return { ok: false, message: await errorOf(r, 'Couldn’t post. Try again.') };
    const b = (await r.json()) as { callout: Callout };
    window.dispatchEvent(new CustomEvent(CALL_POSTED, { detail: b.callout }));
    return { ok: true, callout: b.callout };
  } catch {
    return { ok: false, message: 'Network error. Try again.' };
  }
}

/** Like or unlike; resolves to the new like count, or null if it failed. */
export async function setLike(id: string, on: boolean): Promise<number | null> {
  try {
    const r = await fetch(`${V1}/callouts/${id}/like`, { method: on ? 'POST' : 'DELETE', headers: await authHeaders() });
    if (!r.ok) return null;
    return ((await r.json()) as { likes?: number }).likes ?? null;
  } catch {
    return null;
  }
}

export async function getComments(id: string): Promise<CalloutComment[]> {
  try {
    const r = await fetch(`${V1}/callouts/${id}/comments?limit=50`);
    return r.ok ? (((await r.json()) as { items?: CalloutComment[] }).items ?? []) : [];
  } catch {
    return [];
  }
}

export async function postComment(id: string, body: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const r = await fetch(`${V1}/callouts/${id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify({ body }),
    });
    return r.ok ? { ok: true } : { ok: false, message: await errorOf(r, 'Couldn’t comment. Try again.') };
  } catch {
    return { ok: false, message: 'Network error. Try again.' };
  }
}

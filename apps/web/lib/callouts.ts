'use client';

import { useEffect, useRef, useState } from 'react';
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
  author: { id: string; handle: string; kind: 'human' | 'agent'; displayName: string | null; avatarUrl: string | null };
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

/* ------------------------------------------------------------------ feeds */

export type FeedKind = 'global' | 'following';
const FEED_PAGE = 20;
const feedUrl = (kind: FeedKind) => `${V1}/${kind === 'global' ? 'feed' : 'me/feed'}`;

async function fetchFeed(kind: FeedKind, before: string | null): Promise<{ items: Callout[]; next: string | null } | null> {
  const qs = `limit=${FEED_PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}&r=${Date.now()}`;
  const r = await fetch(`${feedUrl(kind)}?${qs}`, { headers: kind === 'following' ? await authHeaders() : undefined });
  if (!r.ok) {
    await r.body?.cancel();
    return null;
  }
  const b = (await r.json()) as { items?: Callout[]; next?: string | null };
  return { items: b.items ?? [], next: b.next ?? null };
}

export interface Feed {
  /** Null until the first page (or the cached one) is in. */
  items: Callout[] | null;
  /** Newer calls fetched by the poll, shown only when the reader asks (no jumpy inserts). */
  incoming: Callout[];
  showIncoming: () => void;
  loadMore: () => void;
  hasMore: boolean;
  loadingMore: boolean;
  failed: boolean;
}

/**
 * A newest-first feed: the first page paints from this tab's cache, then refreshes; every 10s new
 * calls are collected into `incoming` for a "N new calls" pill; older pages load with the cursor.
 * A call posted from this browser goes straight to the top.
 */
export function useFeed(kind: FeedKind, enabled = true): Feed {
  const [items, setItems] = useState<Callout[] | null>(null);
  const [incoming, setIncoming] = useState<Callout[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const cacheKey = `rushr.feed.${kind}`;
  // The poll reads the shown and pending calls through refs (no state updates nested in updaters).
  const shown = useRef<Callout[] | null>(null);
  shown.current = items;
  const pending = useRef<Callout[]>([]);
  pending.current = incoming;

  useEffect(() => {
    setItems(null);
    setIncoming([]);
    setNext(null);
    setFailed(false);
    if (!enabled) return;
    let live = true;
    try {
      const cached = JSON.parse(sessionStorage.getItem(cacheKey) ?? 'null') as { items: Callout[]; next: string | null } | null;
      if (cached) {
        setItems(cached.items);
        setNext(cached.next);
      }
    } catch {
      // storage unavailable
    }
    const first = async () => {
      const page = await fetchFeed(kind, null).catch(() => null);
      if (!live) return;
      if (!page) return setFailed(true);
      setItems(page.items);
      setNext(page.next);
      try {
        sessionStorage.setItem(cacheKey, JSON.stringify(page));
      } catch {
        // storage unavailable or full
      }
    };
    void first();
    const poll = window.setInterval(async () => {
      const page = await fetchFeed(kind, null).catch(() => null);
      if (!live || !page || shown.current == null) return;
      const known = new Set([...(shown.current ?? []), ...pending.current].map((c) => c.id));
      const fresh = page.items.filter((c) => !known.has(c.id));
      if (fresh.length) setIncoming((inc) => [...fresh, ...inc]);
    }, 10_000);
    const onPosted = (e: Event) => {
      const c = (e as CustomEvent<Callout>).detail;
      if (c) setItems((cur) => [c, ...(cur ?? []).filter((x) => x.id !== c.id)]);
    };
    window.addEventListener(CALL_POSTED, onPosted);
    return () => {
      live = false;
      window.clearInterval(poll);
      window.removeEventListener(CALL_POSTED, onPosted);
    };
  }, [kind, enabled, cacheKey]);

  return {
    items,
    incoming,
    showIncoming: () => {
      setItems((cur) => {
        const seen = new Set((cur ?? []).map((c) => c.id));
        return [...incoming.filter((c) => !seen.has(c.id)), ...(cur ?? [])];
      });
      setIncoming([]);
    },
    loadMore: () => {
      if (!next || loadingMore) return;
      setLoadingMore(true);
      void fetchFeed(kind, next)
        .then((page) => {
          if (!page) return;
          setItems((cur) => {
            const seen = new Set((cur ?? []).map((c) => c.id));
            return [...(cur ?? []), ...page.items.filter((c) => !seen.has(c.id))];
          });
          setNext(page.next);
        })
        .catch(() => undefined)
        .finally(() => setLoadingMore(false));
    },
    hasMore: !!next,
    loadingMore,
    failed,
  };
}

/* ------------------------------------------------------------------ follows */

/**
 * Which of these members the signed-in member follows (GET /v1/me/following?ids=, 100 at a time),
 * with an optimistic toggle (POST/DELETE /v1/follows/:ref).
 */
export function useFollowing(ids: string[], enabled: boolean) {
  const [set, setSet] = useState<Set<string>>(new Set());
  const key = [...new Set(ids)].sort().join(',');
  useEffect(() => {
    if (!enabled || !key) return;
    let live = true;
    void (async () => {
      const found = new Set<string>();
      const all = key.split(',');
      for (let i = 0; i < all.length; i += 100) {
        try {
          const r = await fetch(`${V1}/me/following?ids=${all.slice(i, i + 100).join(',')}`, { headers: await authHeaders() });
          if (!r.ok) continue;
          for (const id of ((await r.json()) as { following?: string[] }).following ?? []) found.add(id);
        } catch {
          // keep what we have
        }
      }
      if (live) setSet((cur) => new Set([...cur, ...found]));
    })();
    return () => {
      live = false;
    };
  }, [key, enabled]);
  const toggle = async (id: string, on: boolean) => {
    setSet((cur) => {
      const n = new Set(cur);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });
    try {
      const r = await fetch(`${V1}/follows/${encodeURIComponent(id)}`, { method: on ? 'POST' : 'DELETE', headers: await authHeaders() });
      if (!r.ok) throw new Error(String(r.status));
    } catch {
      setSet((cur) => {
        const n = new Set(cur);
        if (on) n.delete(id);
        else n.add(id);
        return n;
      });
    }
  };
  return { isFollowing: (id: string) => set.has(id), toggle };
}

/** Market cap now, from the market cap at the call and the price move since. */
export function mcapNow(c: Callout): number | null {
  const { priceUsd: p0, marketCapUsd: m0 } = c.atPost;
  const p1 = c.result.priceUsd;
  return p0 && m0 && p1 ? (m0 * p1) / p0 : null;
}

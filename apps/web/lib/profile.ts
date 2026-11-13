'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_URL } from './api';
import { auth } from './auth';
import { V1 } from './members';

/**
 * Profile data. Members, follows, suggestions and callouts come from the API's /v1 routes; positions
 * and PnL from /wallets/:w/pnl. Every hook degrades to `unavailable` while an endpoint is
 * missing or off, and the page shows an empty state.
 */

export interface ProfileMember {
  id: string;
  handle: string;
  kind: 'human' | 'agent';
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  x: { username: string; verified: boolean } | null;
  wallet: string;
  owner: { id: string; handle: string } | null;
  followers: number;
  following: number;
  createdAt: string;
  agents?: { id: string; handle: string }[];
  callouts?: number;
}

export interface PnlSummary {
  realized_usd: number | null;
  unrealized_usd: number | null;
  realized_24h_usd: number | null;
  realized_7d_usd: number | null;
  realized_30d_usd: number | null;
  volume_usd: number | null;
  trades: number | null;
  tokens_traded: number | null;
  win_rate: number | null;
  best_trade_usd: number | null;
  last_trade_at: string | null;
}

export interface Position {
  token: string;
  symbol: string;
  name: string;
  image_url: string | null;
  price_usd: number | null;
  bought_usd: number;
  sold_usd: number;
  buys: number;
  sells: number;
  held_tokens: string;
  cost_basis_usd: number;
  realized_usd: number;
  unrealized_usd: number;
  first_trade_at: string | null;
  last_trade_at: string | null;
  decimals?: number;
}

export interface Suggestion {
  rank: number;
  member: { id: string; handle: string; kind: 'human' | 'agent'; wallet: string; displayName: string | null; avatarUrl: string | null };
  score: number;
  pnl: number;
  inclAgents: boolean;
  followers: number;
}

export interface Callout {
  id: string;
  token?: { address: string; symbol: string; image_url?: string | null } | null;
  text?: string | null;
  side?: 'buy' | 'sell' | null;
  createdAt: string;
  likes?: number;
  comments?: number;
  entry?: { usd?: number | null; marketCapUsd?: number | null } | null;
  resultPct?: number | null;
}

export type Loadable<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'unavailable' };

async function readJson<T>(r: Response): Promise<T | null> {
  const ct = r.headers.get('content-type') ?? '';
  if (!r.ok || !ct.includes('json')) {
    await r.body?.cancel();
    return null;
  }
  return (await r.json()) as T;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await auth.getAccessToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function useJson<T>(url: string | null, pick: (body: unknown) => T | null, opts: { refreshMs?: number; authed?: boolean; tick?: number } = {}): Loadable<T> {
  const [v, setV] = useState<Loadable<T>>({ state: 'loading' });
  useEffect(() => {
    if (!url) return setV({ state: 'unavailable' });
    let live = true;
    const ctl = new AbortController();
    const run = async () => {
      try {
        const r = await fetch(url, { signal: ctl.signal, headers: opts.authed ? await authHeaders() : undefined });
        const body = await readJson<unknown>(r);
        const data = body == null ? null : pick(body);
        if (live) setV((p) => (data == null ? (p.state === 'ready' ? p : { state: 'unavailable' }) : { state: 'ready', data }));
      } catch (e) {
        if (live && (e as Error).name !== 'AbortError') setV((p) => (p.state === 'ready' ? p : { state: 'unavailable' }));
      }
    };
    void run();
    const id = opts.refreshMs ? setInterval(run, opts.refreshMs) : undefined;
    return () => {
      live = false;
      ctl.abort();
      clearInterval(id);
    };
    // `pick` is a stable inline function per call site; the URL and options decide refetches.
  }, [url, opts.refreshMs, opts.authed, opts.tick]);
  return v;
}

export function useProfileMember(ref: string | null, tick = 0): Loadable<ProfileMember> {
  return useJson(ref ? `${V1}/members/${encodeURIComponent(ref)}` : null, (b) => (b as { member?: ProfileMember }).member ?? null, { tick });
}

export function useWalletPnl(wallet: string | null, tick = 0): Loadable<{ summary: PnlSummary | null; positions: Position[] }> {
  return useJson(
    wallet ? `${API_URL}/wallets/${wallet.toLowerCase()}/pnl` : null,
    (b) => {
      const body = b as { summary?: PnlSummary | null; positions?: Position[] };
      return Array.isArray(body.positions) ? { summary: body.summary ?? null, positions: body.positions } : null;
    },
    { refreshMs: 30_000, tick },
  );
}

export function useSuggestions(signedIn: boolean): Loadable<Suggestion[]> {
  return useJson(signedIn ? `${V1}/me/suggestions?limit=8` : `${V1}/suggestions?limit=8`, (b) => (b as { items?: Suggestion[] }).items ?? null, {
    authed: signedIn,
  });
}

export function useCallouts(ref: string | null): Loadable<Callout[]> {
  return useJson(ref ? `${V1}/members/${encodeURIComponent(ref)}/callouts` : null, (b) => (b as { items?: Callout[] }).items ?? null);
}

/** Follow state for a profile; `self` hides the button on your own profile. */
export function useRelationship(ref: string | null, signedIn: boolean) {
  const [state, setState] = useState<{ self: boolean; following: boolean; followedBy: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!ref || !signedIn) return setState(null);
    let live = true;
    void (async () => {
      try {
        const r = await fetch(`${V1}/me/relationship/${encodeURIComponent(ref)}`, { headers: await authHeaders() });
        const b = await readJson<{ self: boolean; following: boolean; followedBy: boolean }>(r);
        if (live) setState(b);
      } catch {
        if (live) setState(null);
      }
    })();
    return () => {
      live = false;
    };
  }, [ref, signedIn]);
  const toggle = useCallback(async () => {
    if (!ref || !state || busy) return;
    setBusy(true);
    const next = !state.following;
    setState({ ...state, following: next }); // optimistic
    try {
      const r = await fetch(`${V1}/follows/${encodeURIComponent(ref)}`, { method: next ? 'POST' : 'DELETE', headers: await authHeaders() });
      const b = await readJson<{ following: boolean }>(r);
      setState((s) => (s ? { ...s, following: b?.following ?? !next } : s));
    } catch {
      setState((s) => (s ? { ...s, following: !next } : s));
    } finally {
      setBusy(false);
    }
  }, [ref, state, busy]);
  return { state, toggle, busy };
}

export async function followRef(ref: string, on: boolean): Promise<boolean | null> {
  try {
    const r = await fetch(`${V1}/follows/${encodeURIComponent(ref)}`, { method: on ? 'POST' : 'DELETE', headers: await authHeaders() });
    return (await readJson<{ following: boolean }>(r))?.following ?? null;
  } catch {
    return null;
  }
}

export interface ProfilePatch {
  displayName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
}

export async function patchMe(patch: ProfilePatch): Promise<{ ok: true; member: ProfileMember } | { ok: false; message: string }> {
  try {
    const r = await fetch(`${V1}/me`, { method: 'PATCH', headers: { ...(await authHeaders()), 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    const b = await readJson<{ member?: ProfileMember; error?: { message?: string } }>(r.clone());
    if (r.ok && b?.member) return { ok: true, member: b.member };
    const err = await r.json().catch(() => null);
    return { ok: false, message: (err as { error?: { message?: string } } | null)?.error?.message ?? 'Couldn’t save. Try again.' };
  } catch {
    return { ok: false, message: 'Network error. Try again.' };
  }
}

/** Upload an avatar or banner (raw bytes). `disabled` while uploads are off server-side. */
export async function uploadImage(kind: 'avatar' | 'banner', file: File): Promise<{ ok: true; url: string } | { ok: false; code: string; message: string }> {
  try {
    const r = await fetch(`${V1}/me/${kind}`, { method: 'POST', body: file, headers: { ...(await authHeaders()), 'content-type': file.type } });
    if (r.status === 201) {
      const b = (await r.json()) as { url: string };
      return { ok: true, url: b.url };
    }
    const err = ((await r.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null)?.error;
    const code = err?.code ?? (r.status === 404 ? 'feature_disabled' : 'error');
    const message =
      code === 'too_large'
        ? `Too large (max ${kind === 'avatar' ? '1' : '3'} MB).`
        : code === 'unsupported_image'
          ? 'Use a PNG, JPEG, WebP or GIF.'
          : code === 'feature_disabled'
            ? 'Image uploads open soon. Paste an image URL for now.'
            : err?.message ?? 'Upload failed.';
    return { ok: false, code, message };
  } catch {
    return { ok: false, code: 'network', message: 'Network error. Try again.' };
  }
}

/* ------------------------------------------------------------------ ETH price */

type EthQuote = { usd: number; change24h: number | null };
let ethCache: { at: number; q: EthQuote } | null = null;
let ethInflight: Promise<EthQuote | null> | null = null;
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
type DsPairs = {
  pairs?: { chainId: string; baseToken: { address: string }; priceUsd?: string; liquidity?: { usd?: number }; priceChange?: { h24?: number } }[];
};

function loadEth(): Promise<EthQuote | null> {
  if (ethCache && Date.now() - ethCache.at < 60_000) return Promise.resolve(ethCache.q);
  ethInflight ??= fetch(`https://api.dexscreener.com/latest/dex/tokens/${WETH}`)
    .then((r) => (r.ok ? (r.json() as Promise<DsPairs>) : null))
    .then((b) => {
      const pairs = (b?.pairs ?? []).filter((p) => p.chainId === 'robinhood' && p.baseToken.address.toLowerCase() === WETH && p.priceUsd);
      pairs.sort((a, c) => (c.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
      const top = pairs[0];
      if (!top?.priceUsd) return null;
      const q = { usd: Number(top.priceUsd), change24h: top.priceChange?.h24 ?? null };
      ethCache = { at: Date.now(), q };
      return q;
    })
    .catch(() => null)
    .finally(() => {
      ethInflight = null;
    });
  return ethInflight;
}

/**
 * ETH/USD and its 24h change. The Rushr API doesn't expose one yet, so this
 * reads the deepest WETH pool on DexScreener (already allowed by the CSP), cached for a minute.
 */
export function useEthQuote(): EthQuote | null {
  const [q, setQ] = useState<EthQuote | null>(ethCache?.q ?? null);
  useEffect(() => {
    let live = true;
    void loadEth().then((v) => v && live && setQ(v));
    return () => {
      live = false;
    };
  }, []);
  return q;
}

export function useEthUsd(): number | null {
  return useEthQuote()?.usd ?? null;
}

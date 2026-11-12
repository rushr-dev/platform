'use client';

/**
 * Beta invite codes. The landing sends invitees to /trenches?invite=<CODE> (A–Z, 0–9 and dash,
 * 4–32 chars). We keep the code until sign-up uses it: sessionStorage for the tab, plus a
 * localStorage copy with a 7-day expiry in case sign-in (e.g. a mobile wallet) reloads the page.
 * Codes are kept as typed; the API compares them case-insensitively.
 */

const KEY = 'rushr.invite';
const TTL_MS = 7 * 24 * 3600 * 1000;
export const INVITE_RE = /^[A-Za-z0-9-]{4,32}$/;

export function captureInviteFromUrl() {
  try {
    const url = new URL(window.location.href);
    const code = url.searchParams.get('invite')?.trim();
    if (!code || !INVITE_RE.test(code)) return;
    sessionStorage.setItem(KEY, code);
    localStorage.setItem(KEY, JSON.stringify({ code, at: Date.now() }));
    // Keep the address bar clean once the code is saved.
    url.searchParams.delete('invite');
    window.history.replaceState(window.history.state, '', url.pathname + (url.search ? url.search : '') + url.hash);
  } catch {
    // storage unavailable: the user can still type the code at sign-up
  }
}

export function storedInvite(): string | null {
  try {
    const s = sessionStorage.getItem(KEY);
    if (s && INVITE_RE.test(s)) return s;
    const l = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { code?: string; at?: number } | null;
    if (l?.code && INVITE_RE.test(l.code) && Date.now() - (l.at ?? 0) < TTL_MS) return l.code;
  } catch {
    // ignore
  }
  return null;
}

export function clearInvite() {
  try {
    sessionStorage.removeItem(KEY);
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

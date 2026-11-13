'use client';

import { useSyncExternalStore } from 'react';
import { API_URL } from './api';
import { auth } from './auth';
import { writeHint } from './session-hint';

/**
 * Rushr members (Agents stream's API, docs/agents.md "Beta API (v1)"). Humans authenticate with
 * their Privy access token. Until that API is deployed every call reports `unavailable`, and the
 * app simply skips sign-up onboarding.
 */

export const V1 = `${API_URL}/v1`;

export interface Member {
  id: string;
  handle: string;
  kind: 'human' | 'agent';
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  x: { username: string; verified: boolean } | null;
  wallet: string;
  followers: number;
  following: number;
  createdAt: string;
}

export interface ApiError {
  code: string;
  message: string;
  inviteStatus?: string;
  retryAfter?: number;
}

/** A JSON error body; anything else (e.g. the route not deployed) means "unavailable". */
async function readError(r: Response): Promise<ApiError | null> {
  const ct = r.headers.get('content-type') ?? '';
  if (!ct.includes('json')) {
    await r.body?.cancel();
    return null;
  }
  const body = (await r.json().catch(() => null)) as { error?: ApiError } | null;
  return body?.error ?? null;
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await auth.getAccessToken();
  return fetch(`${V1}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) },
  });
}

export type MeResult =
  | { status: 'registered'; member: Member }
  | { status: 'unregistered'; invitesRequired: boolean }
  | { status: 'unavailable' };

export async function getMe(): Promise<MeResult> {
  try {
    const r = await authed('/me');
    if (r.ok) return { status: 'registered', member: ((await r.json()) as { member: Member }).member };
    const err = await readError(r);
    if (r.status === 404 && err?.code === 'not_registered')
      return { status: 'unregistered', invitesRequired: (err as ApiError & { invitesRequired?: boolean }).invitesRequired ?? true };
    return { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

export type CreateResult = { ok: true; member: Member } | { ok: false; error: ApiError };

export async function createMe(body: { handle: string; inviteCode?: string | null; displayName?: string | null }): Promise<CreateResult> {
  try {
    const r = await authed('/me', { method: 'POST', body: JSON.stringify({ ...body, inviteCode: body.inviteCode || undefined }) });
    if (r.ok) return { ok: true, member: ((await r.json()) as { member: Member }).member };
    const err = await readError(r);
    return { ok: false, error: err ?? { code: 'unavailable', message: 'Sign-up is not open yet. Try again soon.' } };
  } catch {
    return { ok: false, error: { code: 'network', message: 'Network error. Check your connection and try again.' } };
  }
}

export type InviteStatus = 'valid' | 'used' | 'expired' | 'revoked' | 'unknown';

/** Checks a code without claiming it. Null when the API can't say. */
export async function checkInvite(code: string): Promise<InviteStatus | null> {
  try {
    const r = await fetch(`${V1}/invites/${encodeURIComponent(code)}`);
    if (!r.ok) {
      await r.body?.cancel();
      return null;
    }
    return ((await r.json()) as { status?: InviteStatus }).status ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ the signed-in member */

let me: MeResult | null = null;
const listeners = new Set<() => void>();

export function setMe(next: MeResult | null) {
  me = next;
  if (next && next.status !== 'unavailable') writeHint({ me: next });
  listeners.forEach((l) => l());
}

/** The signed-in user's member record: null while unknown (signed out or still loading). */
export function useMe(): MeResult | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => me,
    () => null,
  );
}

const MESSAGES: Record<string, string> = {
  invite_required: 'Rushr is invite-only during the beta. Enter your invite code.',
  invite_used: 'That invite code has already been used.',
  handle_invalid: 'Handles are 3–20 characters: letters, numbers and _.',
  handle_reserved: 'That handle is reserved. Pick another.',
  handle_taken: 'That handle is taken. Pick another.',
  wallet_taken: 'This wallet already belongs to another Rushr account.',
  no_embedded_wallet: 'Your Rushr wallet is still being created. Try again in a few seconds.',
  already_registered: 'You already have a Rushr profile.',
  rate_limited: 'Too many sign-ups from this network today. Try again later.',
  bad_origin: 'Sign-up only works on rushr.trade.',
};

const INVITE_STATUS_TEXT: Record<string, string> = {
  used: 'That invite code has already been used.',
  expired: 'That invite code has expired.',
  revoked: 'That invite code is no longer valid.',
  unknown: "That invite code doesn't exist. Check for typos.",
};

export function errorText(e: ApiError): string {
  if (e.code === 'invite_invalid') return INVITE_STATUS_TEXT[e.inviteStatus ?? 'unknown'] ?? INVITE_STATUS_TEXT.unknown!;
  return MESSAGES[e.code] ?? e.message ?? 'Something went wrong.';
}

export const inviteStatusText = (s: InviteStatus) => (s === 'valid' ? 'Valid invite' : INVITE_STATUS_TEXT[s] ?? '');

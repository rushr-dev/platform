'use client';

import { useSyncExternalStore } from 'react';
import { clearHint, writeHint } from './session-hint';

/**
 * Sign-in state and actions, without importing Privy. The Privy SDK is large, so it loads lazily
 * after the page is on screen (components/auth/privy-host.tsx) and plugs its hooks into this store.
 * Anything in the terminal can read the session or call `auth.login()` without pulling Privy into
 * its own bundle; a login requested before the SDK has loaded runs as soon as it has.
 */

export interface AuthUser {
  id: string;
  email: string | null;
  twitter: { username: string; avatar: string | null } | null;
  /** The user's Privy embedded wallet on Robinhood Chain (created on sign-up). */
  wallet: `0x${string}` | null;
  /** An external wallet the user signed in with, if any. */
  externalWallet: `0x${string}` | null;
}

export interface AuthState {
  /** False until a Privy app ID is configured for this build. */
  enabled: boolean;
  /** The SDK has loaded and restored (or ruled out) a session. */
  ready: boolean;
  authenticated: boolean;
  user: AuthUser | null;
}

export interface TxRequest {
  to: `0x${string}`;
  data?: `0x${string}`;
  value?: bigint;
  gas?: bigint;
}

/** A fully specified EIP-1559 transaction to SIGN only (quick trades broadcast it themselves). */
export interface SignTxRequest {
  chainId: number;
  nonce: number;
  to: `0x${string}`;
  data: `0x${string}`;
  value: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** What the Privy bridge implements. */
export interface AuthActions {
  login(): void;
  logout(): Promise<void>;
  exportWallet(): Promise<void>;
  /** Sign and send from the embedded wallet with Privy's confirmation UI off. Resolves with the hash. */
  sendTransaction(tx: TxRequest): Promise<`0x${string}`>;
  /** Sign (never send) from the embedded wallet, UI off. Resolves with the serialized signed tx. */
  signTransaction(tx: SignTxRequest): Promise<`0x${string}`>;
  getAccessToken(): Promise<string | null>;
}

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? '';

let state: AuthState = { enabled: !!APP_ID, ready: false, authenticated: false, user: null };
let actions: AuthActions | null = null;
let loginRequested = false;
const listeners = new Set<() => void>();
const loaders = new Set<() => void>();

export const privyAppId = () => APP_ID;

/** Called by the Privy bridge. */
export function setAuthState(next: Partial<AuthState>) {
  state = { ...state, ...next };
  // Remember who is signed in so the next page load can paint their bits before the SDK loads.
  if (state.ready && state.authenticated && state.user) writeHint({ wallet: state.user.wallet, name: displayName(state.user) });
  else if (state.ready && !state.authenticated) clearHint();
  listeners.forEach((l) => l());
}

/** Called by the Privy bridge once its hooks are live. */
export function setAuthActions(next: AuthActions | null) {
  actions = next;
  if (next && loginRequested) {
    loginRequested = false;
    next.login();
  }
}

/** The auth root registers how to load the SDK on demand. */
export function onAuthLoadRequest(load: () => void) {
  loaders.add(load);
  return () => loaders.delete(load);
}

const notReady = () => new Error('Sign-in is still loading');

export const auth = {
  get state() {
    return state;
  },
  login() {
    if (!state.enabled) return;
    if (actions) return actions.login();
    // SDK not loaded yet: remember the click and load it now.
    loginRequested = true;
    loaders.forEach((l) => l());
  },
  logout: () => actions?.logout() ?? Promise.resolve(),
  exportWallet: () => (actions ? actions.exportWallet() : Promise.reject(notReady())),
  sendTransaction: (tx: TxRequest) => (actions ? actions.sendTransaction(tx) : Promise.reject(notReady())),
  signTransaction: (tx: SignTxRequest) => (actions ? actions.signTransaction(tx) : Promise.reject(notReady())),
  /** Load the SDK now (e.g. a trade button is on screen) instead of after the idle delay. */
  preload() {
    if (state.enabled && !actions) loaders.forEach((l) => l());
  },
  getAccessToken: () => (actions ? actions.getAccessToken() : Promise.resolve(null)),
};

export function useAuth(): AuthState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}

/** Display name: X handle, then email, then the short wallet. */
export function displayName(u: AuthUser | null): string {
  if (!u) return '';
  if (u.twitter) return `@${u.twitter.username}`;
  if (u.email) return u.email.split('@')[0]!;
  const w = u.wallet ?? u.externalWallet;
  return w ? `${w.slice(0, 6)}…${w.slice(-4)}` : 'Account';
}

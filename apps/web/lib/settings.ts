'use client';

import { useSyncExternalStore } from 'react';

/**
 * Trading preferences, kept in this browser for the beta (server-side settings can replace the
 * storage later without touching callers). Read with `useSettings()`, change with `updateSettings`.
 */

export interface TradeSettings {
  /** One-tap buy amounts in ETH (token page presets; the first is the trenches quick-buy default). */
  buyPresets: [string, string, string, string];
  /** Sell presets in % of the position. */
  sellPresets: [number, number, number];
  /** The amount trenches' one-tap Buy uses, in ETH (P1). */
  quickBuy: string;
  /** The second one-tap Buy on trenches cards (P2), in ETH. */
  quickBuy2: string;
  /**
   * Slippage: 'auto' (5–15% from the token's age, volatility and price impact, plus its measured
   * tax) or a fixed percentage.
   */
  slippagePct: number | 'auto';
  /** Per-trade cap in ETH: buys above it are refused before signing. */
  maxTradeEth: number;
}

export const DEFAULT_SETTINGS: TradeSettings = {
  buyPresets: ['0.01', '0.05', '0.1', '0.5'],
  sellPresets: [25, 50, 100],
  quickBuy: '0.01',
  quickBuy2: '0.05',
  slippagePct: 'auto',
  // Founder spec: 0.25 ETH per trade unless the user raises it.
  maxTradeEth: 0.25,
};

/** Hard bounds the settings page enforces. */
export const LIMITS = { slippagePct: [0.1, 50], maxTradeEth: [0.001, 5] } as const;

/**
 * v2: slippage 'auto' and a 0.25 ETH cap became the defaults. Saves under the first key held the old
 * defaults (every quick-buy change wrote the whole object), so only presets and the quick-buy
 * amount carry over; slippage and cap start from the new defaults.
 */
const KEY = 'rushr.settings.v2';
const V1_KEY = 'rushr.settings';
const LEGACY_QUICK_KEY = 'rushr.quickbuy';

let current: TradeSettings = DEFAULT_SETTINGS;
let loaded = false;
const listeners = new Set<() => void>();

function load() {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<TradeSettings> | null;
    if (raw) {
      current = sanitize({ ...DEFAULT_SETTINGS, ...raw });
    } else {
      const v1 = JSON.parse(localStorage.getItem(V1_KEY) ?? 'null') as Partial<TradeSettings> | null;
      const legacyQuick = localStorage.getItem(LEGACY_QUICK_KEY);
      current = sanitize({
        ...DEFAULT_SETTINGS,
        ...(v1?.buyPresets ? { buyPresets: v1.buyPresets } : {}),
        ...(v1?.sellPresets ? { sellPresets: v1.sellPresets } : {}),
        ...(v1?.quickBuy || legacyQuick ? { quickBuy: (v1?.quickBuy ?? legacyQuick)! } : {}),
      });
    }
  } catch {
    // storage unavailable: defaults for this visit
  }
}

const num = (v: unknown, lo: number, hi: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
};
const ethStr = (v: unknown, fallback: string) => {
  const s = String(v ?? '').trim();
  return /^\d*\.?\d+$/.test(s) && Number(s) > 0 ? s : fallback;
};

/** 'auto', or a fixed percentage within bounds; anything unreadable falls back to 'auto'. */
function slippageOf(v: unknown): TradeSettings['slippagePct'] {
  if (v === 'auto' || v === null || v === undefined || v === '') return 'auto';
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(LIMITS.slippagePct[1], Math.max(LIMITS.slippagePct[0], n)) : 'auto';
}

export function sanitize(s: TradeSettings): TradeSettings {
  return {
    buyPresets: [0, 1, 2, 3].map((i) => ethStr(s.buyPresets?.[i], DEFAULT_SETTINGS.buyPresets[i]!)) as TradeSettings['buyPresets'],
    sellPresets: [0, 1, 2].map((i) => num(s.sellPresets?.[i], 1, 100, DEFAULT_SETTINGS.sellPresets[i]!)) as TradeSettings['sellPresets'],
    quickBuy: ethStr(s.quickBuy, DEFAULT_SETTINGS.quickBuy),
    quickBuy2: ethStr(s.quickBuy2, DEFAULT_SETTINGS.quickBuy2),
    slippagePct: slippageOf(s.slippagePct),
    maxTradeEth: num(s.maxTradeEth, LIMITS.maxTradeEth[0], LIMITS.maxTradeEth[1], DEFAULT_SETTINGS.maxTradeEth),
  };
}

export function getSettings(): TradeSettings {
  load();
  return current;
}

export function updateSettings(patch: Partial<TradeSettings>) {
  load();
  current = sanitize({ ...current, ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
    localStorage.setItem(LEGACY_QUICK_KEY, current.quickBuy);
  } catch {
    // storage unavailable: applies for this visit
  }
  listeners.forEach((l) => l());
}

/** Settings for rendering. The server (and the first client render) use the defaults. */
export function useSettings(): TradeSettings {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getSettings,
    () => DEFAULT_SETTINGS,
  );
}

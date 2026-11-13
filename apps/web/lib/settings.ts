'use client';

import { useSyncExternalStore } from 'react';

/**
 * Trading preferences, kept in this browser for the beta (server-side settings can replace the
 * storage later without touching callers). Read with `useSettings()`, change with `updateSettings`.
 */

/** One trading preset (P1/P2/P3 on the token page): its own buy amounts, sell percentages and slippage. */
export interface TradePreset {
  buy: [string, string, string, string];
  sell: [number, number, number, number];
  slippagePct: number | 'auto';
}

export interface TradeSettings {
  /** One-tap buy amounts in ETH (token page presets; the first is the trenches quick-buy default). */
  buyPresets: [string, string, string, string];
  /** Sell presets in % of the position. */
  sellPresets: [number, number, number, number];
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
  /**
   * P1/P2/P3. The active one mirrors into `buyPresets`, `sellPresets` and `slippagePct`, which is
   * what the quote engine and the settings page read.
   */
  presets: [TradePreset, TradePreset, TradePreset];
  activePreset: 0 | 1 | 2;
}

export const DEFAULT_SETTINGS: TradeSettings = {
  buyPresets: ['0.01', '0.05', '0.1', '0.5'],
  sellPresets: [5, 25, 50, 100],
  quickBuy: '0.01',
  quickBuy2: '0.05',
  slippagePct: 'auto',
  // A conservative default cap: 0.25 ETH per trade unless the user raises it.
  maxTradeEth: 0.25,
  presets: [
    { buy: ['0.01', '0.05', '0.1', '0.5'], sell: [5, 25, 50, 100], slippagePct: 'auto' },
    { buy: ['0.02', '0.1', '0.2', '0.25'], sell: [10, 25, 50, 100], slippagePct: 'auto' },
    { buy: ['0.005', '0.01', '0.02', '0.05'], sell: [25, 50, 75, 100], slippagePct: 'auto' },
  ],
  activePreset: 0,
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
      // A save from before P1–P3: its flat presets and slippage become P1.
      if (!raw.presets) current = mirror(current, { buyPresets: current.buyPresets });
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

function presetOf(v: Partial<TradePreset> | undefined, d: TradePreset): TradePreset {
  // Saves from before P1–P3 had three sell presets; those fall back to the four defaults.
  const sell = Array.isArray(v?.sell) && v.sell.length === 4 ? v.sell : d.sell;
  return {
    buy: [0, 1, 2, 3].map((i) => ethStr(v?.buy?.[i], d.buy[i]!)) as TradePreset['buy'],
    sell: [0, 1, 2, 3].map((i) => num(sell[i], 1, 100, d.sell[i]!)) as TradePreset['sell'],
    slippagePct: slippageOf(v?.slippagePct),
  };
}

export function sanitize(s: TradeSettings): TradeSettings {
  const sells = Array.isArray(s.sellPresets) && s.sellPresets.length === 4 ? s.sellPresets : DEFAULT_SETTINGS.sellPresets;
  const active = ([0, 1, 2] as const).includes(s.activePreset) ? s.activePreset : 0;
  return {
    buyPresets: [0, 1, 2, 3].map((i) => ethStr(s.buyPresets?.[i], DEFAULT_SETTINGS.buyPresets[i]!)) as TradeSettings['buyPresets'],
    sellPresets: [0, 1, 2, 3].map((i) => num(sells[i], 1, 100, DEFAULT_SETTINGS.sellPresets[i]!)) as TradeSettings['sellPresets'],
    quickBuy: ethStr(s.quickBuy, DEFAULT_SETTINGS.quickBuy),
    quickBuy2: ethStr(s.quickBuy2, DEFAULT_SETTINGS.quickBuy2),
    slippagePct: slippageOf(s.slippagePct),
    maxTradeEth: num(s.maxTradeEth, LIMITS.maxTradeEth[0], LIMITS.maxTradeEth[1], DEFAULT_SETTINGS.maxTradeEth),
    presets: [0, 1, 2].map((i) => presetOf(s.presets?.[i], DEFAULT_SETTINGS.presets[i]!)) as TradeSettings['presets'],
    activePreset: active,
  };
}

/**
 * Keep the active preset and the flat fields in step. A patch that changes presets or switches the
 * active one copies that preset out; a patch to the flat fields (the settings page) writes them into
 * the active preset.
 */
function mirror(s: TradeSettings, patch: Partial<TradeSettings>): TradeSettings {
  const i = s.activePreset;
  if (patch.presets || patch.activePreset !== undefined) {
    const p = s.presets[i];
    return { ...s, buyPresets: p.buy, sellPresets: p.sell, slippagePct: p.slippagePct };
  }
  if (patch.buyPresets || patch.sellPresets || patch.slippagePct !== undefined) {
    const presets = s.presets.map((p, j) => (j === i ? { buy: s.buyPresets, sell: s.sellPresets, slippagePct: s.slippagePct } : p)) as TradeSettings['presets'];
    return { ...s, presets };
  }
  return s;
}

export function getSettings(): TradeSettings {
  load();
  return current;
}

export function updateSettings(patch: Partial<TradeSettings>) {
  load();
  current = mirror(sanitize({ ...current, ...patch }), patch);
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

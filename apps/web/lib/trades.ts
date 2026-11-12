/**
 * Trade maths for the token page: one compact trade shape for API and socket rows, rolling
 * window stats, maker tags, top traders and early buyers. Everything here is computed from the
 * trades we already have, so it works before the API grows dedicated endpoints for it.
 */

import type { Candle, Trade } from './api';

/** How many trades the token page loads up front (the API's maximum). */
export const TRADE_LIMIT = 500;

export interface Tx {
  /** `${tx}:${logIndex}`, unique per swap. */
  id: string;
  tx: string;
  /** Unix seconds. */
  time: number;
  trader: string;
  side: 'buy' | 'sell';
  priceUsd: number | null;
  usd: number | null;
  /** Whole tokens (already divided by decimals). */
  tokens: number | null;
}

/** Socket payload from the indexer's live path. */
export interface LiveTrade {
  tx: string;
  logIndex: number;
  time: number;
  trader: string;
  side: 'buy' | 'sell';
  tokenAmount?: string;
  priceUsd: number | null;
  usd: number | null;
}

export function toWhole(raw: string | null | undefined, decimals: number): number | null {
  if (!raw) return null;
  try {
    const v = BigInt(raw);
    const shift = Math.max(0, decimals - 6);
    return Number(v / 10n ** BigInt(shift)) / 10 ** (decimals - shift);
  } catch {
    return null;
  }
}

export const fromApi = (t: Trade, decimals: number): Tx => ({
  id: `${t.tx}:${t.log_index}`,
  tx: t.tx,
  time: Math.floor(new Date(t.time).getTime() / 1000),
  trader: t.trader,
  side: t.side,
  priceUsd: t.price_usd,
  usd: t.usd,
  tokens: toWhole(t.token_amount, decimals),
});

export const fromLive = (t: LiveTrade, decimals: number): Tx => ({
  id: `${t.tx}:${t.logIndex}`,
  tx: t.tx,
  time: t.time,
  trader: t.trader,
  side: t.side,
  priceUsd: t.priceUsd,
  usd: t.usd,
  tokens: toWhole(t.tokenAmount, decimals),
});

/** Merge newest-first lists without duplicates, keeping at most `cap` rows. */
export function mergeTrades(fresh: Tx[], prev: Tx[], cap = 1000): Tx[] {
  const seen = new Set(prev.map((p) => p.id));
  const add = fresh.filter((f) => !seen.has(f.id)).sort((a, b) => b.time - a.time);
  return add.length ? [...add, ...prev].slice(0, cap) : prev;
}

/* ------------------------------------------------------------------ rolling windows */

export const WINDOWS = [
  { id: 'm5', label: '5m', secs: 300 },
  { id: 'h1', label: '1h', secs: 3600 },
  { id: 'h6', label: '6h', secs: 21600 },
  { id: 'h24', label: '24h', secs: 86400 },
] as const;
export type WindowId = (typeof WINDOWS)[number]['id'];

export interface WindowStats {
  change: number | null;
  volume: number;
  trades: number;
  buys: number;
  sells: number;
  buyUsd: number;
  sellUsd: number;
  makers: number;
  /** False when our trade list doesn't reach back to the window start (buy/sell split is partial). */
  complete: boolean;
}

/**
 * Volume and trade counts come from 1m candles (complete for 24h) plus live trades newer than the
 * last candle; the buy/sell split comes from the trade list, which may not cover a whole day.
 */
export function windowStats(trades: Tx[], candles: Candle[], nowSec: number, priceNow: number | null): Record<WindowId, WindowStats> {
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  const lastCandleEnd = sorted.length ? sorted[sorted.length - 1]!.time + 60 : 0;
  const oldestTrade = trades.length ? trades[trades.length - 1]!.time : Infinity;
  const out = {} as Record<WindowId, WindowStats>;
  for (const w of WINDOWS) {
    const from = nowSec - w.secs;
    let volume = 0;
    let count = 0;
    for (const c of sorted) {
      if (c.time + 60 <= from) continue;
      volume += c.volume ?? 0;
      count += c.trades ?? 0;
    }
    let buys = 0;
    let sells = 0;
    let buyUsd = 0;
    let sellUsd = 0;
    const makers = new Set<string>();
    for (const t of trades) {
      if (t.time < from) break;
      makers.add(t.trader);
      if (t.side === 'buy') {
        buys++;
        buyUsd += t.usd ?? 0;
      } else {
        sells++;
        sellUsd += t.usd ?? 0;
      }
      if (t.time >= lastCandleEnd) {
        volume += t.usd ?? 0;
        count++;
      }
    }
    // Before the window: last close at or before `from`; a younger token compares with its first open.
    let base: number | null = null;
    for (const c of sorted) {
      if (c.time > from) break;
      base = c.close;
    }
    base ??= sorted.find((c) => c.open > 0)?.open ?? null;
    const complete = oldestTrade <= from;
    out[w.id] = {
      change: base && priceNow ? ((priceNow - base) / base) * 100 : null,
      volume,
      trades: Math.max(count, buys + sells),
      buys,
      sells,
      buyUsd,
      sellUsd,
      makers: makers.size,
      complete,
    };
  }
  return out;
}

/* ------------------------------------------------------------------ makers */

export type MakerTag = 'dev' | 'whale' | 'top10' | 'sniper' | 'bundler' | 'insider' | 'fresh' | 'airdrop';

export interface HolderInfo {
  wallet: string;
  pct: number;
  amount: string;
  tags: string[];
  funder: string | null;
}

export interface MakerContext {
  deployer: string;
  holders: Map<string, HolderInfo & { rank: number }>;
}

export const WHALE_PCT = 1;
export const WHALE_USD = 2_500;

export function holderContext(deployer: string, holders: HolderInfo[] | null): MakerContext {
  return { deployer, holders: new Map((holders ?? []).map((h, i) => [h.wallet, { ...h, rank: i + 1 }])) };
}

const TAG_ORDER: MakerTag[] = ['dev', 'whale', 'top10', 'sniper', 'bundler', 'insider', 'fresh', 'airdrop'];

/** Tags for a wallet: from the holder snapshot, plus dev and whale (big holder or a big trade). */
export function makerTags(wallet: string, ctx: MakerContext, tradeUsd?: number | null): MakerTag[] {
  const h = ctx.holders.get(wallet);
  const tags = new Set<MakerTag>();
  if (wallet === ctx.deployer) tags.add('dev');
  if ((h && h.pct >= WHALE_PCT) || (tradeUsd ?? 0) >= WHALE_USD) tags.add('whale');
  if (h && h.rank <= 10) tags.add('top10');
  for (const t of h?.tags ?? []) if ((TAG_ORDER as string[]).includes(t)) tags.add(t as MakerTag);
  return TAG_ORDER.filter((t) => tags.has(t));
}

/* ------------------------------------------------------------------ traders */

export interface TraderRow {
  wallet: string;
  buys: number;
  sells: number;
  boughtUsd: number;
  soldUsd: number;
  boughtTokens: number;
  soldTokens: number;
  firstTime: number;
  lastTime: number;
  /** Token balance from the holder snapshot when known. */
  holding: number | null;
  holdingPct: number | null;
  /** Realized + unrealized at the current price, over the trades we can see. */
  pnl: number;
}

export function traders(trades: Tx[], ctx: MakerContext, priceNow: number | null, decimals: number): TraderRow[] {
  const by = new Map<string, TraderRow>();
  for (const t of trades) {
    let r = by.get(t.trader);
    if (!r) {
      const h = ctx.holders.get(t.trader);
      r = {
        wallet: t.trader, buys: 0, sells: 0, boughtUsd: 0, soldUsd: 0, boughtTokens: 0, soldTokens: 0,
        firstTime: t.time, lastTime: t.time,
        holding: h ? toWhole(h.amount, decimals) : null,
        holdingPct: h?.pct ?? null,
        pnl: 0,
      };
      by.set(t.trader, r);
    }
    r.firstTime = Math.min(r.firstTime, t.time);
    r.lastTime = Math.max(r.lastTime, t.time);
    if (t.side === 'buy') {
      r.buys++;
      r.boughtUsd += t.usd ?? 0;
      r.boughtTokens += t.tokens ?? 0;
    } else {
      r.sells++;
      r.soldUsd += t.usd ?? 0;
      r.soldTokens += t.tokens ?? 0;
    }
  }
  for (const r of by.values()) {
    // Value only what they still hold from the buys we saw (never more than the snapshot says).
    const left = Math.max(0, r.boughtTokens - r.soldTokens);
    const held = r.holding == null ? left : Math.min(left, r.holding);
    r.pnl = r.soldUsd - r.boughtUsd + held * (priceNow ?? 0);
  }
  return [...by.values()];
}

/** Whether the trade list reaches back to the token's first trades. */
export function coversLaunch(trades: Tx[], createdAtMs: number, fetched: number, limit: number, launchIndexed: boolean): boolean {
  // Tokens found after launch only have the indexer's recent replay, not their first trades.
  if (!trades.length || !launchIndexed) return false;
  if (fetched < limit) return true;
  return trades[trades.length - 1]!.time * 1000 - createdAtMs < 5 * 60_000;
}

export interface EarlyBuyer extends TraderRow {
  order: number;
  status: 'holding' | 'sold some' | 'sold all' | 'bought more';
}

export function earlyBuyers(rows: TraderRow[], trades: Tx[], n = 50): EarlyBuyer[] {
  const firstBuy = new Map<string, number>();
  for (const t of trades) if (t.side === 'buy') firstBuy.set(t.trader, Math.min(firstBuy.get(t.trader) ?? Infinity, t.time));
  const ordered = rows.filter((r) => firstBuy.has(r.wallet)).sort((a, b) => firstBuy.get(a.wallet)! - firstBuy.get(b.wallet)!);
  return ordered.slice(0, n).map((r, i) => {
    const held = r.holding ?? Math.max(0, r.boughtTokens - r.soldTokens);
    const status: EarlyBuyer['status'] =
      held <= r.boughtTokens * 0.001 ? 'sold all' : r.soldTokens > 0 ? 'sold some' : r.buys > 1 ? 'bought more' : 'holding';
    return { ...r, order: i + 1, status };
  });
}

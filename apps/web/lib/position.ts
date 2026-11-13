'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { API_URL } from './api';
import type { Tx } from './trades';

/**
 * A wallet's live position in one token, for the token page (trade panel numbers, chart markers).
 *
 * - Server truth: the API's `GET /wallets/:w/positions/:token` (position + that wallet's trades).
 * - Price: recomputed on every price tick the page passes in, so value and PnL move with the chart.
 * - Own trades: the `rushr:trade` event (from components/trade/use-quick-trade.ts) applies a trade optimistically the
 *   moment its hash is final; on `confirmed` the position is refetched until the indexer has the
 *   hash, then the optimistic copy drops. Trades from this wallet seen on the live feed (another
 *   device, a bot) trigger the same refetch.
 */

export interface ServerPosition {
  decimals: number;
  price_usd: number | null;
  bought_tokens: string;
  bought_usd: number;
  sold_tokens: string;
  sold_usd: number;
  buys: number;
  sells: number;
  held_tokens: string;
  cost_basis_usd: number;
  realized_usd: number;
  unrealized_usd: number;
}

interface ServerTrade {
  tx: string;
  log_index: number;
  time: string;
  side: 'buy' | 'sell';
  token_amount: string;
  quote_amount: string | null;
  usd: number | null;
  price_usd: number | null;
}

/** A trade drawn on the chart: the server's, a pending one of ours, or one fresh off the feed. */
export interface OwnTrade {
  id: string;
  tx: string | null;
  /** Unix seconds. */
  time: number;
  side: 'buy' | 'sell';
  usd: number | null;
  /** Whole tokens. */
  tokens: number | null;
  priceUsd: number | null;
  pending: boolean;
}

export interface LivePosition {
  /** False until the first server read (or when there is no wallet). */
  loaded: boolean;
  /** Whole tokens held, pending trades included. */
  held: number;
  heldUsd: number | null;
  boughtUsd: number;
  /** Whole tokens bought in total (for the average entry). */
  boughtTokens: number;
  soldUsd: number;
  costBasisUsd: number;
  realizedUsd: number;
  unrealizedUsd: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  /** True while an own trade is applied optimistically and not yet confirmed by the indexer. */
  syncing: boolean;
  trades: OwnTrade[];
}

/** Mirrors TradeEventDetail in components/trade/use-quick-trade.ts. */
interface TradeEvent {
  phase: 'submitting' | 'submitted' | 'confirmed' | 'failed';
  token: string;
  decimals: number;
  side: 'buy' | 'sell';
  amountIn: string;
  expectedOut: string | null;
  wallet: string;
  hash?: string;
}

interface Pending {
  key: string;
  hash: string | null;
  side: 'buy' | 'sell';
  /** Buys: ETH in; sells: whole tokens in. */
  amountIn: number;
  /** Buys: whole tokens out; sells: ETH out. */
  out: number;
  time: number;
  confirmed: boolean;
}

const whole = (raw: string | null | undefined, decimals: number) => {
  if (!raw) return 0;
  try {
    const v = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    return Number(v / base) + Number(v % base) / Number(base);
  } catch {
    return Number(raw) || 0;
  }
};

const RECONCILE_MS = [1_200, 3_000, 6_000, 12_000, 25_000];

export function usePosition({
  wallet,
  token,
  decimals,
  priceUsd,
  ethUsd,
  feed,
}: {
  wallet: string | null;
  token: string;
  decimals: number;
  priceUsd: number | null;
  ethUsd: number | null;
  /** The page's live trade list (newest first). */
  feed: Tx[] | null;
}): LivePosition {
  const w = wallet?.toLowerCase() ?? null;
  const t = token.toLowerCase();
  const [server, setServer] = useState<{ key: string; position: ServerPosition | null; trades: ServerTrade[] } | null>(null);
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState<Pending[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const key = w ? `${w}:${t}` : null;

  // Server read; `tick` forces a fresh one (the query busts the 10s edge cache).
  useEffect(() => {
    if (!w) return setServer(null);
    const k = `${w}:${t}`;
    const cacheKey = `rushr.position.${k}`;
    // Paint the last answer for this wallet and token at once (this tab only); the fetch replaces it.
    if (tick === 0)
      try {
        const cached = JSON.parse(sessionStorage.getItem(cacheKey) ?? 'null') as { position: ServerPosition | null; trades: ServerTrade[] } | null;
        if (cached) setServer((cur) => (cur?.key === k ? cur : { key: k, ...cached }));
      } catch {
        // storage unavailable
      }
    const ctl = new AbortController();
    fetch(`${API_URL}/wallets/${w}/positions/${t}${tick ? `?r=${tick}` : ''}`, { signal: ctl.signal })
      .then(async (r) => {
        if (r.status === 404) return { position: null, trades: [] };
        if (!r.ok) throw new Error(String(r.status));
        return (await r.json()) as { position: ServerPosition | null; trades?: ServerTrade[] };
      })
      .then((b) => {
        const next = { position: b.position, trades: b.trades ?? [] };
        setServer({ key: k, ...next });
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify(next));
        } catch {
          // storage unavailable or full
        }
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, [w, t, tick]);

  // Backstop: refresh every 60s while the page is open.
  useEffect(() => {
    if (!w) return;
    const id = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(id);
  }, [w]);

  const reconcile = () => {
    for (const ms of RECONCILE_MS) timers.current.push(setTimeout(() => setTick((x) => x + 1), ms));
  };
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    },
    [key],
  );

  // Own trades from this browser, the moment they're signed.
  useEffect(() => {
    if (!w) return;
    setPending([]);
    const on = (e: Event) => {
      const d = (e as CustomEvent<TradeEvent>).detail;
      if (!d || d.wallet?.toLowerCase() !== w || d.token?.toLowerCase() !== t) return;
      const k = d.hash ?? `${d.side}:${d.amountIn}`;
      if (d.phase === 'submitted') {
        const amountIn = d.side === 'buy' ? whole(d.amountIn, 18) : whole(d.amountIn, d.decimals);
        const out = d.side === 'buy' ? whole(d.expectedOut, d.decimals) : whole(d.expectedOut, 18);
        setPending((p) => [...p.filter((x) => x.key !== k && x.key !== `${d.side}:${d.amountIn}`), { key: k, hash: d.hash ?? null, side: d.side, amountIn, out, time: Date.now() / 1000, confirmed: false }]);
      } else if (d.phase === 'confirmed') {
        setPending((p) => p.map((x) => (x.key === k ? { ...x, confirmed: true } : x)));
        reconcile();
      } else if (d.phase === 'failed') {
        setPending((p) => p.filter((x) => x.key !== k && x.key !== `${d.side}:${d.amountIn}`));
      }
    };
    window.addEventListener('rushr:trade', on);
    return () => window.removeEventListener('rushr:trade', on);
  }, [w, t]);

  // Trades from this wallet on the live feed: refetch so the server numbers catch up.
  const seenFeed = useRef<string | null>(null);
  const feedMine = useMemo(() => (w && feed ? feed.filter((x) => x.trader.toLowerCase() === w) : []), [feed, w]);
  useEffect(() => {
    const top = feedMine[0]?.id ?? '';
    if (seenFeed.current !== null && top && top !== seenFeed.current) reconcile();
    seenFeed.current = top;
  }, [feedMine]);

  const current = server && server.key === key ? server : null;
  const serverTx = useMemo(() => new Set((current?.trades ?? []).map((x) => x.tx.toLowerCase())), [current]);

  // Drop pending trades once the indexer has them.
  useEffect(() => {
    if (!pending.length) return;
    const left = pending.filter((p) => !p.hash || !serverTx.has(p.hash.toLowerCase()));
    if (left.length !== pending.length) setPending(left);
  }, [serverTx, pending]);

  return useMemo<LivePosition>(() => {
    const pos = current?.position ?? null;
    const dec = pos?.decimals ?? decimals;
    let held = pos ? whole(pos.held_tokens, dec) : 0;
    let bought = pos?.bought_usd ?? 0;
    let boughtTokens = pos ? whole(pos.bought_tokens, dec) : 0;
    let sold = pos?.sold_usd ?? 0;
    let cost = pos?.cost_basis_usd ?? 0;
    let realized = pos?.realized_usd ?? 0;
    const live = pending.filter((p) => !p.hash || !serverTx.has(p.hash.toLowerCase()));
    for (const p of live) {
      if (p.side === 'buy') {
        const spent = ethUsd ? p.amountIn * ethUsd : p.out * (priceUsd ?? 0);
        held += p.out;
        boughtTokens += p.out;
        bought += spent;
        cost += spent;
      } else {
        const amt = Math.min(p.amountIn, held);
        const proceeds = ethUsd ? p.out * ethUsd : amt * (priceUsd ?? 0);
        const avg = held > 0 ? cost / held : 0;
        realized += proceeds - avg * amt;
        cost -= avg * amt;
        held -= amt;
        sold += proceeds;
      }
    }
    const heldUsd = priceUsd != null ? held * priceUsd : null;
    const unrealized = heldUsd != null ? heldUsd - cost : null;
    const pnl = unrealized != null ? realized + unrealized : null;
    const trades: OwnTrade[] = [];
    const ids = new Set<string>();
    for (const x of current?.trades ?? []) {
      const tokens = whole(x.token_amount, dec);
      ids.add(x.tx.toLowerCase());
      trades.push({ id: `${x.tx}:${x.log_index}`, tx: x.tx, time: Math.floor(new Date(x.time).getTime() / 1000), side: x.side, usd: x.usd, tokens, priceUsd: x.price_usd, pending: false });
    }
    for (const x of feedMine) {
      if (ids.has(x.tx.toLowerCase())) continue;
      ids.add(x.tx.toLowerCase());
      trades.push({ id: x.id, tx: x.tx, time: x.time, side: x.side, usd: x.usd, tokens: x.tokens, priceUsd: x.priceUsd, pending: false });
    }
    for (const p of live) {
      if (p.hash && ids.has(p.hash.toLowerCase())) continue;
      const tokens = p.side === 'buy' ? p.out : p.amountIn;
      const usdV = ethUsd ? (p.side === 'buy' ? p.amountIn : p.out) * ethUsd : null;
      trades.push({ id: `pending:${p.key}`, tx: p.hash, time: Math.floor(p.time), side: p.side, usd: usdV, tokens, priceUsd: priceUsd, pending: true });
    }
    trades.sort((a, b) => a.time - b.time);
    return {
      loaded: !!current,
      held,
      heldUsd,
      boughtUsd: bought,
      boughtTokens,
      soldUsd: sold,
      costBasisUsd: cost,
      realizedUsd: realized,
      unrealizedUsd: unrealized,
      pnlUsd: pnl,
      pnlPct: pnl != null && bought > 0 ? (pnl / bought) * 100 : null,
      syncing: live.length > 0,
      trades,
    };
  }, [current, pending, serverTx, feedMine, priceUsd, ethUsd, decimals]);
}

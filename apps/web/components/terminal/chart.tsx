'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts';
import { API_URL, type Candle } from '@/lib/api';
import { usd } from '@/lib/format';
import type { Hydration } from '@/lib/feed/protocol';
import type { OwnTrade } from '@/lib/position';
import { TradePills, type Pill } from './trade-pills';
import type { Tx } from '@/lib/trades';

/**
 * Seconds per candle. 1s and 30s are built in the browser from the trade list (the API stores
 * 1m candles); the rest come from the API's candle endpoint.
 */
const INTERVALS = { '1s': 1, '30s': 30, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 } as const;
type Interval = keyof typeof INTERVALS;
const FROM_TRADES = new Set<Interval>(['1s', '30s']);
const HOURS: Partial<Record<Interval, number>> = { '1m': 24, '5m': 72, '15m': 168, '1h': 168, '4h': 168 };

const UP = '#36d42a';
const DOWN = '#ff6b5b';

interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Candles shown as market cap (GMGN's default) or price. New trades from the socket update the
 * last candle in place, so the chart moves with every swap. An OHLC legend follows the crosshair.
 */
export function PriceChart({
  address,
  initial,
  seconds = null,
  supply,
  trades,
  priceUsd = null,
  hydration,
  marks = null,
}: {
  address: string;
  /** 1m candles for the last 24h; null while they load. */
  initial: Candle[] | null;
  /** Server-built 1s candles (feed v2, last ~30 min). 1s and 30s use them instead of the trade list. */
  seconds?: Candle[] | null;
  /** Token supply in whole tokens; multiplies price into market cap. */
  supply: number;
  /** Newest first, live trades included. */
  trades: Tx[] | null;
  /** Current price: seeds a live bar when there is no history, so the chart is never empty. */
  priceUsd?: number | null;
  /** Server-side backfill state (feed v2): shows "fetching from chain" while history streams in. */
  hydration?: Hydration;
  /** The signed-in wallet's trades on this token: B/S markers snapped to the interval's candles. */
  marks?: OwnTrade[] | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const pills = useRef<TradePills | null>(null);
  const last = useRef<Bar | null>(null);
  const bars = useRef(new Map<number, Bar>());
  const appliedTop = useRef<string | null>(null);
  const [interval, setIv] = useState<Interval>('1m');
  const [mode, setMode] = useState<'mcap' | 'price'>('mcap');
  const [fetched, setFetched] = useState<{ iv: Interval; data: Candle[] } | null>(null);
  const [legend, setLegend] = useState<Bar | null>(null);
  const [hovering, setHovering] = useState(false);
  const scale = mode === 'mcap' && supply > 0 ? supply : 1;

  // Remember the last interval and mode.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('rushr.chart') ?? '{}') as { iv?: Interval; mode?: 'mcap' | 'price' };
      if (saved.iv && saved.iv in INTERVALS) setIv(saved.iv);
      if (saved.mode === 'price' || saved.mode === 'mcap') setMode(saved.mode);
    } catch {
      // storage unavailable
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('rushr.chart', JSON.stringify({ iv: interval, mode }));
    } catch {
      // storage unavailable
    }
  }, [interval, mode]);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8a958a', fontFamily: 'var(--font-geist-mono)', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.14, bottom: 0.22 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { horzLine: { color: 'rgba(255,255,255,0.2)' }, vertLine: { color: 'rgba(255,255,255,0.2)' } },
      localization: { priceFormatter: (p: number) => usdPrecise(p) },
    });
    candles.current = c.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN,
      priceFormat: { type: 'custom', formatter: (p: number) => usdPrecise(p), minMove: 1e-12 },
    });
    volume.current = c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' } });
    pills.current = new TradePills((time) => bars.current.get(time));
    candles.current.attachPrimitive(pills.current);
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    const onMove = (p: MouseEventParams) => {
      const bar = p.time == null ? null : bars.current.get(p.time as number);
      setHovering(!!bar);
      if (bar) setLegend(bar);
    };
    c.subscribeCrosshairMove(onMove);
    chart.current = c;
    return () => {
      c.unsubscribeCrosshairMove(onMove);
      pills.current = null;
      c.remove();
    };
  }, []);

  useEffect(() => {
    chart.current?.applyOptions({ timeScale: { secondsVisible: INTERVALS[interval] < 60 } });
  }, [interval]);

  // Fetch API candles for intervals other than 1m (already server-rendered) and the trade-built ones.
  useEffect(() => {
    if (FROM_TRADES.has(interval) || interval === '1m') return;
    const ctl = new AbortController();
    fetch(`${API_URL}/tokens/${address}/candles?interval=${interval}&hours=${HOURS[interval]}`, { signal: ctl.signal })
      .then((r) => r.json() as Promise<{ candles: Candle[] }>)
      .then((d) => setFetched({ iv: interval, data: d.candles ?? [] }))
      .catch(() => undefined);
    return () => ctl.abort();
  }, [interval, address]);

  // The base series for this interval. Trade-built series only rebuild on interval change; new
  // trades after that are applied incrementally below.
  const tradesReady = trades != null;
  // Like trades, server 1s candles only rebuild the series once (when they first arrive); live
  // updates after that come through the trade list.
  const secondsReady = !!seconds?.length;
  const priceRef = useRef(priceUsd);
  priceRef.current = priceUsd;
  const rawBase = useMemo<Candle[] | null>(() => {
    if (FROM_TRADES.has(interval)) {
      if (secondsReady && seconds?.length) return interval === '1s' ? seconds : rebucket(seconds, INTERVALS[interval]);
      return trades ? fromTrades(trades, INTERVALS[interval]) : null;
    }
    if (interval === '1m') return initial;
    return fetched?.iv === interval ? fetched.data : null;
  }, [interval, initial, fetched, tradesReady, secondsReady]);
  // No history yet (a brand-new or still-hydrating token): start from one bar at the current price
  // and let live trades build the chart from there.
  const seeded = rawBase != null && rawBase.length === 0 && priceUsd != null && priceUsd > 0;
  const base = useMemo<Candle[] | null>(() => {
    if (!rawBase || rawBase.length || !priceRef.current) return rawBase;
    const step = INTERVALS[interval];
    const t = Math.floor(Date.now() / 1000 / step) * step;
    const p = priceRef.current;
    return [{ time: t, open: p, high: p, low: p, close: p, volume: 0 }];
  }, [rawBase, interval, seeded]);
  // Fit the view once per interval; later redraws (history streaming in) keep the user's zoom.
  const fitted = useRef<string | null>(null);

  // Draw the full series whenever the base data or the mode changes.
  useEffect(() => {
    if (!base) return;
    const series = continuous(base);
    bars.current = new Map(series.map((k) => [k.time, scaled(k, scale)]));
    candles.current?.setData(series.map((k) => ({ time: k.time as UTCTimestamp, ...ohlc(k, scale) })));
    volume.current?.setData(series.map((k) => ({ time: k.time as UTCTimestamp, value: k.volume, color: volColor(k) })));
    const tail = series[series.length - 1] ?? null;
    last.current = tail;
    setLegend(tail ? scaled(tail, scale) : null);
    // null: trades not loaded yet (whatever arrives first is history); '': none so far.
    appliedTop.current = trades ? (trades[0]?.id ?? '') : null;
    const n = series.length;
    const fitKey = `${interval}:${n > 1 ? 'data' : 'seed'}`;
    if (fitted.current !== fitKey) {
      fitted.current = fitKey;
      // Show the most recent ~120 bars rather than squeezing the whole history in.
      if (n > 150) chart.current?.timeScale().setVisibleLogicalRange({ from: n - 120, to: n + 4 });
      else chart.current?.timeScale().fitContent();
    }
    // trades intentionally excluded: they are applied incrementally below
  }, [base, scale]);

  // Apply trades newer than the last applied one to the live candle.
  useEffect(() => {
    if (!trades?.length || !base) return;
    if (appliedTop.current === null) {
      appliedTop.current = trades[0]!.id;
      return;
    }
    const fresh: Tx[] = [];
    for (const t of trades) {
      if (t.id === appliedTop.current) break;
      fresh.push(t);
    }
    appliedTop.current = trades[0]!.id;
    if (!fresh.length) return;
    const step = INTERVALS[interval];
    for (const t of fresh.reverse()) {
      if (!t.priceUsd) continue;
      const bucket = Math.floor(t.time / step) * step;
      const l = last.current;
      if (l && bucket < l.time) continue;
      const bar: Bar =
        l && l.time === bucket
          ? { ...l, high: Math.max(l.high, t.priceUsd), low: Math.min(l.low, t.priceUsd), close: t.priceUsd, volume: l.volume + (t.usd ?? 0) }
          : { time: bucket, open: l?.close ?? t.priceUsd, high: Math.max(t.priceUsd, l?.close ?? 0), low: Math.min(t.priceUsd, l?.close ?? t.priceUsd), close: t.priceUsd, volume: t.usd ?? 0 };
      last.current = bar;
      bars.current.set(bar.time, scaled(bar, scale));
      candles.current?.update({ time: bar.time as UTCTimestamp, ...ohlc(bar, scale) });
      volume.current?.update({ time: bar.time as UTCTimestamp, value: bar.volume, color: volColor(bar) });
    }
    if (!hovering && last.current) setLegend(scaled(last.current, scale));
  }, [trades, interval, scale, base, hovering]);

  // Own trades grouped per candle of this interval (buys and sells apart), for markers and the legend.
  const ownByBar = useMemo(() => {
    const m = new Map<number, { buys: OwnTrade[]; sells: OwnTrade[] }>();
    if (!marks?.length) return m;
    const step = INTERVALS[interval];
    for (const x of marks) {
      const bucket = Math.floor(x.time / step) * step;
      const g = m.get(bucket) ?? { buys: [], sells: [] };
      (x.side === 'buy' ? g.buys : g.sells).push(x);
      m.set(bucket, g);
    }
    return m;
  }, [marks, interval]);

  // Pills: green B under the candle for buys, red S over it for sells, on candles the series has
  // (a pending trade whose candle isn't drawn yet appears when its trade reaches the chart).
  // Re-applied when trades, the interval's bars or the live candle change.
  const lastBar = last.current?.time ?? 0;
  useEffect(() => {
    const api = pills.current;
    if (!api) return;
    const out: Pill[] = [];
    for (const [bucket, g] of ownByBar) {
      if (!bars.current.has(bucket)) continue;
      if (g.buys.length) out.push({ time: bucket, side: 'buy', count: g.buys.length, pending: g.buys.some((x) => x.pending) });
      if (g.sells.length) out.push({ time: bucket, side: 'sell', count: g.sells.length, pending: g.sells.some((x) => x.pending) });
    }
    api.set(out);
  }, [ownByBar, base, scale, lastBar]);

  const ownHere = legend ? ownByBar.get(legend.time) : undefined;
  const empty = base != null && base.length === 0 && !(trades?.length && FROM_TRADES.has(interval));
  const hydrating = isHydrating(hydration);
  const loading = base == null;
  const ch = legend && legend.open ? ((legend.close - legend.open) / legend.open) * 100 : null;
  const up = (ch ?? 0) >= 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-0.5 overflow-x-auto px-2 py-2 text-xs [scrollbar-width:none]">
        {(Object.keys(INTERVALS) as Interval[]).map((i) => (
          <button
            key={i}
            type="button"
            onClick={() => setIv(i)}
            title={FROM_TRADES.has(i) ? 'Built from recent trades' : undefined}
            className={`shrink-0 rounded-md px-2 py-1 font-mono ${interval === i ? 'bg-white/[0.08] text-ink' : 'text-muted hover:text-ink'}`}
          >
            {i}
          </button>
        ))}
        <div className="ml-auto flex shrink-0 rounded-lg bg-white/[0.04] p-0.5">
          {(['mcap', 'price'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-2 py-0.5 ${mode === m ? 'bg-white/[0.1] text-ink' : 'text-muted'}`}
            >
              {m === 'mcap' ? 'MCap' : 'Price'}
            </button>
          ))}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={box} className="absolute inset-0" />
        {legend && (
          <div className="pointer-events-none absolute left-3 top-1 z-10 flex flex-wrap gap-x-2.5 font-mono text-[11px] text-muted">
            <span>
              O <span className={up ? 'text-brand' : 'text-risk-high'}>{usdPrecise(legend.open)}</span>
            </span>
            <span>
              H <span className={up ? 'text-brand' : 'text-risk-high'}>{usdPrecise(legend.high)}</span>
            </span>
            <span>
              L <span className={up ? 'text-brand' : 'text-risk-high'}>{usdPrecise(legend.low)}</span>
            </span>
            <span>
              C <span className={up ? 'text-brand' : 'text-risk-high'}>{usdPrecise(legend.close)}</span>
            </span>
            {ch != null && <span className={up ? 'text-brand' : 'text-risk-high'}>{`${up ? '+' : ''}${ch.toFixed(2)}%`}</span>}
            <span>
              Vol <span className="text-ink/80">{usd(legend.volume)}</span>
            </span>
            {ownHere && <OwnLegend g={ownHere} scale={scale} />}
          </div>
        )}
        {loading && <div className="absolute inset-x-6 bottom-10 top-10 animate-pulse rounded-xl bg-white/[0.025]" />}
        {hydrating ? (
          <HydratingPill hydration={hydration!} />
        ) : (
          seeded && (
            <span className="pointer-events-none absolute bottom-9 left-1/2 z-10 -translate-x-1/2 rounded-full bg-surface-2/90 px-2.5 py-1 text-[11px] text-muted ring-1 ring-white/[0.06]">
              No trades in this window yet · live from the current price
            </span>
          )
        )}
        {empty && (
          <p className="pointer-events-none absolute inset-0 grid place-items-center text-xs text-muted">
            {FROM_TRADES.has(interval) ? 'No recent trades to build this view from.' : 'No trades in this window yet.'}
          </p>
        )}
      </div>
    </div>
  );
}

/** Merge finer candles into coarser buckets (1s → 30s). */
function rebucket(list: Candle[], step: number): Candle[] {
  const out = new Map<number, Candle>();
  for (const c of list) {
    const b = Math.floor(c.time / step) * step;
    const k = out.get(b);
    if (k) {
      k.high = Math.max(k.high, c.high);
      k.low = Math.min(k.low, c.low);
      k.close = c.close;
      k.volume += c.volume;
    } else out.set(b, { ...c, time: b });
  }
  return [...out.values()];
}

function fromTrades(trades: Tx[], step: number): Candle[] {
  const out = new Map<number, Candle>();
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i]!;
    if (!t.priceUsd) continue;
    const b = Math.floor(t.time / step) * step;
    const k = out.get(b);
    if (k) {
      k.high = Math.max(k.high, t.priceUsd);
      k.low = Math.min(k.low, t.priceUsd);
      k.close = t.priceUsd;
      k.volume += t.usd ?? 0;
    } else out.set(b, { time: b, open: t.priceUsd, high: t.priceUsd, low: t.priceUsd, close: t.priceUsd, volume: t.usd ?? 0 });
  }
  return [...out.values()];
}

const ohlc = (k: Bar, s: number) => ({ open: k.open * s, high: k.high * s, low: k.low * s, close: k.close * s });
const scaled = (k: Bar, s: number): Bar => ({ ...k, ...ohlc(k, s) });
const volColor = (k: Bar) => (k.close >= k.open ? 'rgba(54,212,42,0.35)' : 'rgba(255,107,91,0.35)');

/**
 * Chain candles the way GMGN/TradingView do: each one opens at the previous close, so price moves
 * between trades show up as the next candle's body instead of a visual gap. Highs and lows are
 * widened to include that open.
 */
function continuous(data: Candle[]): Bar[] {
  const out: Bar[] = [];
  let prevClose: number | null = null;
  for (const k of [...data].sort((a, b) => a.time - b.time)) {
    if (!(k.close > 0)) continue;
    const open = prevClose ?? k.open;
    out.push({ time: k.time, open, high: Math.max(k.high, open, k.close), low: Math.min(k.low, open, k.close), close: k.close, volume: k.volume });
    prevClose = k.close;
  }
  return out;
}

function usdPrecise(n: number) {
  if (n >= 1000) return usd(n);
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n === 0) return '$0';
  return `$${n.toPrecision(4)}`;
}

const SOURCE_TEXT = { chain: 'from chain', index: 'from the Rushr index', mixed: 'from chain and index' } as const;

const span = (secs: number) => {
  const h = secs / 3600;
  if (h >= 23.5) return `${Math.round(h / 24)}d`;
  if (h >= 1) return `${Math.round(h)}h`;
  return `${Math.max(1, Math.round(secs / 60))}m`;
};

/** "Fetching history from chain · last 6h loaded" / "Partial history from chain · last 24h". */
export function hydrationLabel(h: Hydration): { title: string; detail: string | null } {
  const from = SOURCE_TEXT[h.source ?? 'chain'];
  const covered = h.covered && h.covered.to > h.covered.from ? `last ${span(h.covered.to - h.covered.from)}` : null;
  if (h.state === 'partial') return { title: `Partial history ${from}`, detail: covered ? `${covered} so far` : null };
  return { title: `Fetching history ${from}`, detail: covered ? `${covered} loaded` : null };
}

export const isHydrating = (h?: Hydration | null) => h?.state === 'hydrating' || h?.state === 'partial';

/** "Fetching history from chain · last 30m loaded": the server is still backfilling this token. */
export function HydratingPill({ hydration, className = '' }: { hydration: Hydration; className?: string }) {
  const { title, detail } = hydrationLabel(hydration);
  return (
    <span
      role="status"
      className={`pointer-events-none absolute right-3 top-1 z-10 flex items-center gap-1.5 rounded-full bg-surface-2/90 px-2.5 py-1 text-[11px] text-ink/85 ring-1 ring-brand/25 ${className}`}
    >
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand/60" />
        <span className="relative inline-flex size-2 rounded-full bg-brand" />
      </span>
      {title}
      {detail && <span className="font-mono text-muted">· {detail}</span>}
    </span>
  );
}

/** "You: B $250 @ $146K · S $90" for the hovered candle. */
function OwnLegend({ g, scale }: { g: { buys: OwnTrade[]; sells: OwnTrade[] }; scale: number }) {
  const part = (list: OwnTrade[]) => {
    const total = list.reduce((t, x) => t + (x.usd ?? 0), 0);
    const priced = list.filter((x) => x.priceUsd != null);
    const avg = priced.length ? priced.reduce((t, x) => t + x.priceUsd!, 0) / priced.length : null;
    return `${usd(total)}${avg != null ? ` @ ${usdPrecise(avg * scale)}` : ''}${list.some((x) => x.pending) ? ' (pending)' : ''}`;
  };
  return (
    <span className="text-ink/80">
      You{g.buys.length > 0 && <span className="ml-1 text-brand">B {part(g.buys)}</span>}
      {g.sells.length > 0 && <span className="ml-1 text-risk-high">S {part(g.sells)}</span>}
    </span>
  );
}

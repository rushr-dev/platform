'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type UTCTimestamp,
} from 'lightweight-charts';
import { API_URL, type Candle } from '@/lib/api';
import { price, usd } from '@/lib/format';
import type { Hydration } from '@/lib/feed/protocol';
import type { Callout } from '@/lib/callouts';
import type { OwnTrade } from '@/lib/position';
import { iconSrc } from './bits';
import { avatarSeed, MemberAvatar } from './member-avatar';
import { CALL_RADIUS, CallMarks, TradePills, type CallMark, type Pill } from './trade-pills';

/** At most this many calls are drawn (the most recent), so the chart stays readable. */
const MAX_CALL_MARKS = 30;
import type { Tx } from '@/lib/trades';

/**
 * Seconds per candle. 1s and 30s are built in the browser from the trade list (the API stores
 * 1m candles); the rest come from the API's candle endpoint.
 */
const INTERVALS = { '1s': 1, '30s': 30, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 } as const;
type Interval = keyof typeof INTERVALS;
const FROM_TRADES = new Set<Interval>(['1s', '30s']);
const HOURS: Partial<Record<Interval, number>> = { '1m': 24, '5m': 72, '15m': 168, '1h': 168, '4h': 168 };

/** Candle width plus gap, in CSS pixels, when a view is framed; and empty bars kept right of the latest. */
const BAR_SPACING = 7;
const RIGHT_OFFSET = 6;

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
  calls = null,
  selectedCall = null,
  onSelectCall,
  avgBuy = null,
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
  /** Members' calls on this token, newest first: avatar markers at each call's time and price. */
  calls?: Callout[] | null;
  selectedCall?: string | null;
  onSelectCall?: (id: string | null) => void;
  /** The signed-in wallet's average buy price (USD) while it holds the token: a dashed line on the axis. */
  avgBuy?: number | null;
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
  const [showCalls, setShowCalls] = useState(true);
  const [showTrades, setShowTrades] = useState(true);
  // The call pill under the cursor, with its centre in the chart pane (CSS pixels).
  const [hoverCall, setHoverCall] = useState<{ call: Callout; x: number; y: number; others: number } | null>(null);
  const callsById = useRef(new Map<string, Callout>());
  const callMarks = useRef<CallMarks | null>(null);
  // Calls by candle for hover and click (read inside chart callbacks, so kept in a ref).
  const callsByBar = useRef(new Map<number, Callout[]>());
  const onSelectRef = useRef(onSelectCall);
  onSelectRef.current = onSelectCall;
  const scale = mode === 'mcap' && supply > 0 ? supply : 1;

  // Remember the last interval and mode.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('rushr.chart') ?? '{}') as { iv?: Interval; mode?: 'mcap' | 'price'; calls?: boolean; trades?: boolean };
      if (saved.iv && saved.iv in INTERVALS) setIv(saved.iv);
      if (saved.mode === 'price' || saved.mode === 'mcap') setMode(saved.mode);
      if (saved.calls === false) setShowCalls(false);
      if (saved.trades === false) setShowTrades(false);
    } catch {
      // storage unavailable
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('rushr.chart', JSON.stringify({ iv: interval, mode, calls: showCalls, trades: showTrades }));
    } catch {
      // storage unavailable
    }
  }, [interval, mode, showCalls, showTrades]);

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8a958a', fontFamily: 'var(--font-geist-mono)', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      // Top margin keeps the highest candle clear of the OHLC legend; entireTextOnly drops a corner
      // label that would be cut by the pane edge; minimumWidth fits labels like "$136.0K".
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.18, bottom: 0.22 }, entireTextOnly: true, minimumWidth: 64 },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: RIGHT_OFFSET, barSpacing: BAR_SPACING },
      crosshair: { horzLine: { color: 'rgba(255,255,255,0.2)' }, vertLine: { color: 'rgba(255,255,255,0.2)' } },
      localization: { priceFormatter: (p: number) => usdPrecise(p) },
    });
    candles.current = c.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, borderVisible: false, wickUpColor: UP, wickDownColor: DOWN,
      priceFormat: { type: 'custom', formatter: (p: number) => usdPrecise(p), minMove: 1e-12 },
    });
    // Volume sits on its own hidden scale with no last-value tag, so it never crowds the price axis.
    volume.current = c.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    pills.current = new TradePills((time) => bars.current.get(time));
    candles.current.attachPrimitive(pills.current);
    callMarks.current = new CallMarks();
    candles.current.attachPrimitive(callMarks.current);
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    const onMove = (p: MouseEventParams) => {
      const bar = p.time == null ? null : bars.current.get(p.time as number);
      setHovering(!!bar);
      if (bar) setLegend(bar);
      const hit = p.point ? callMarks.current?.hit(p.point.x, p.point.y) : null;
      const call = hit ? callsById.current.get(hit.item.id) : undefined;
      setHoverCall(
        hit && call ? { call, x: hit.x, y: hit.y, others: Math.max(0, (callsByBar.current.get(hit.item.time)?.length ?? 1) - 1) } : null,
      );
    };
    // Clicking a call pill selects it; clicking elsewhere on a candle with calls selects the newest.
    const onClick = (p: MouseEventParams) => {
      const hit = p.point ? callMarks.current?.hit(p.point.x, p.point.y) : null;
      if (hit) return onSelectRef.current?.(hit.item.id);
      const here = p.time == null ? undefined : callsByBar.current.get(p.time as number);
      if (here?.length) onSelectRef.current?.(here[0]!.id);
    };
    c.subscribeCrosshairMove(onMove);
    c.subscribeClick(onClick);
    chart.current = c;
    return () => {
      c.unsubscribeCrosshairMove(onMove);
      c.unsubscribeClick(onClick);
      pills.current = null;
      callMarks.current = null;
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
    // Frame at a fixed candle width with the latest candle near the right and history to its left.
    // A few candles stay at that width on the right instead of being stretched across the pane.
    const fit = () => {
      const ts = chart.current?.timeScale();
      ts?.applyOptions({ barSpacing: BAR_SPACING, rightOffset: RIGHT_OFFSET });
      ts?.scrollToRealTime();
    };
    if (fitted.current !== fitKey) {
      fitted.current = fitKey;
      fit();
    } else {
      // The series can change length after the first fit (e.g. the live feed's window replacing the
      // 24h history). Empty space on the left is fine while every candle is in view; empty space
      // on the left with the latest candle off to the right is not.
      const vr = chart.current?.timeScale().getVisibleLogicalRange();
      if (vr && vr.from < -2 && vr.to < n - 1) fit();
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
    for (const [bucket, g] of showTrades ? ownByBar : []) {
      if (!bars.current.has(bucket)) continue;
      if (g.buys.length) out.push({ time: bucket, side: 'buy', count: g.buys.length, pending: g.buys.some((x) => x.pending) });
      if (g.sells.length) out.push({ time: bucket, side: 'sell', count: g.sells.length, pending: g.sells.some((x) => x.pending) });
    }
    api.set(out);
  }, [ownByBar, base, scale, lastBar, showTrades]);

  // Average buy: a price line on the candle series (it doesn't take part in autoscale), in the
  // active mode's units (market cap or price), redrawn when the position or the mode changes.
  useEffect(() => {
    const series = candles.current;
    if (!series || avgBuy == null || !(avgBuy > 0)) return;
    const line = series.createPriceLine({
      price: avgBuy * scale,
      color: '#36d42a',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `Avg buy ${scale > 1 ? `${usd(avgBuy * scale)} MC` : usdPrecise(avgBuy)}`,
    });
    return () => series.removePriceLine(line);
  }, [avgBuy, scale]);

  // Call markers: the most recent calls, at the candle of each call and the price (or market cap)
  // when it was posted.
  useEffect(() => {
    const api = callMarks.current;
    if (!api) return;
    const byBar = new Map<number, Callout[]>();
    const out: CallMark[] = [];
    if (showCalls && calls?.length) {
      const step = INTERVALS[interval];
      for (const c of calls.slice(0, MAX_CALL_MARKS)) {
        const price = c.atPost.priceUsd;
        if (price == null) continue;
        const bucket = Math.floor(new Date(c.createdAt).getTime() / 1000 / step) * step;
        if (!bars.current.has(bucket)) continue;
        byBar.set(bucket, [...(byBar.get(bucket) ?? []), c]);
        out.push({
          id: c.id,
          time: bucket,
          value: price * scale,
          stance: c.stance,
          handle: c.author.handle,
          seed: avatarSeed(c.author),
          imageSrc: c.author.avatarUrl ? iconSrc(c.author.avatarUrl) : null,
          selected: c.id === selectedCall,
        });
      }
    }
    callsByBar.current = byBar;
    callsById.current = new Map((calls ?? []).map((c) => [c.id, c]));
    api.set(out);
  }, [calls, selectedCall, showCalls, interval, base, scale, lastBar]);

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
        <div className="ml-auto flex shrink-0 gap-1 pl-2">
          {calls != null && (
            <ChipToggle on={showCalls} onClick={() => setShowCalls(!showCalls)} label="Calls" />
          )}
          {marks != null && <ChipToggle on={showTrades} onClick={() => setShowTrades(!showTrades)} label="My trades" short="Mine" />}
        </div>
        <div className="ml-1 flex shrink-0 rounded-lg bg-white/[0.04] p-0.5">
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
          // right-[76px]: stays clear of the price axis column, so it never covers the top label.
          <div className="pointer-events-none absolute left-3 right-[76px] top-1 z-10 flex flex-wrap gap-x-2.5 font-mono text-[11px] text-muted">
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
        {hoverCall && <CallHover hover={hoverCall} scale={scale} />}
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

/**
 * Axis and legend prices: compact dollars, subscript zeros for tiny prices, never e-notation. The
 * margins under the lowest candle can reach below zero; those ticks get no label.
 */
function usdPrecise(n: number) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n === 0) return '$0';
  // Two decimals under $100K so a narrow range still gets distinct ticks ($3.44K, $3.46K).
  if (n >= 1000 && n < 1e5) return `$${(n / 1e3).toFixed(2)}K`;
  if (n >= 1000) return usd(n);
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return price(n);
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

function ChipToggle({ on, onClick, label, short }: { on: boolean; onClick: () => void; label: string; short?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={`shrink-0 rounded-md border px-2 py-0.5 ${on ? 'border-white/15 bg-white/[0.06] text-ink' : 'border-white/[0.06] text-muted line-through decoration-white/30'}`}
    >
      {short ? (
        <>
          <span className="sm:hidden">{short}</span>
          <span className="hidden sm:inline">{label}</span>
        </>
      ) : (
        label
      )}
    </button>
  );
}

const HOVER_W = 288;
/** Gap between the pill's edge and the card, so the card never covers the pill. */
const HOVER_GAP = CALL_RADIUS + 8;

/**
 * Hover card for one call, anchored to its pill: above it, or below when there's no room at the
 * top of the chart, and kept inside the chart horizontally.
 */
function CallHover({ hover, scale }: { hover: { call: Callout; x: number; y: number; others: number }; scale: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const c = hover.call;
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    const h = el.offsetHeight;
    const w = box.clientWidth;
    const left = Math.min(Math.max(4, hover.x - HOVER_W / 2), Math.max(4, w - HOVER_W - 4));
    const above = hover.y - HOVER_GAP - h;
    setPos({ left, top: above >= 4 ? above : hover.y + HOVER_GAP });
  }, [hover.x, hover.y, c.id]);
  const at = c.atPost.priceUsd != null ? (scale > 1 ? `${usd(c.atPost.priceUsd * scale)} MC` : usdPrecise(c.atPost.priceUsd)) : null;
  const since = c.result.sincePostPct;
  const bull = c.stance === 'bullish';
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute z-20 rounded-xl border border-white/[0.1] bg-surface-2/95 p-3 text-xs shadow-2xl backdrop-blur-sm"
      style={{ width: HOVER_W, left: pos?.left ?? -9999, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      role="tooltip"
    >
      <div className="flex items-center gap-2">
        <MemberAvatar member={c.author} size={22} />
        <span className="min-w-0 truncate font-medium text-ink">@{c.author.handle}</span>
        <span className={`ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${bull ? 'bg-go/15 text-go' : 'bg-risk-high/15 text-risk-high'}`}>
          {bull ? 'Bullish' : 'Bearish'}
        </span>
      </div>
      <p className="mt-2 line-clamp-4 whitespace-pre-line break-words text-[13px] leading-snug text-ink/90">{c.body}</p>
      {(at || since != null) && (
        <p className="mt-2 font-mono text-[11px] text-muted">
          {at && <>called at {at}</>}
          {at && since != null && ' · '}
          {since != null && <span className={since >= 0 ? 'text-go' : 'text-risk-high'}>{`${since >= 0 ? '+' : ''}${since.toFixed(0)}% since`}</span>}
        </p>
      )}
      {hover.others > 0 && <p className="mt-1 text-[11px] text-muted">+{hover.others} more call{hover.others > 1 ? 's' : ''} on this candle</p>}
    </div>
  );
}

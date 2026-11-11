'use client';

import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { API_URL, type Candle } from '@/lib/api';
import { usd } from '@/lib/format';

const INTERVALS = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600 } as const;
type Interval = keyof typeof INTERVALS;

export interface Tick {
  time: number;
  priceUsd: number;
  usd: number | null;
}

/**
 * Candles from the indexer, shown as market cap (GMGN's default) or price. New trades from the
 * socket update the last candle in place, so the chart moves with every swap.
 */
export function PriceChart({
  address,
  initial,
  supply,
  ticks,
}: {
  address: string;
  initial: Candle[];
  /** Token supply in whole tokens; multiplies price into market cap. */
  supply: number;
  ticks: Tick[];
}) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volume = useRef<ISeriesApi<'Histogram'> | null>(null);
  const last = useRef<{ time: number; open: number; high: number; low: number; close: number; volume: number } | null>(null);
  const seen = useRef(0);
  const [interval, setIv] = useState<Interval>('1m');
  const [mode, setMode] = useState<'mcap' | 'price'>('mcap');
  const [data, setData] = useState<Candle[]>(initial);
  const scale = mode === 'mcap' && supply > 0 ? supply : 1;

  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#8a958a', fontFamily: 'var(--font-geist-mono)', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: 'rgba(255,255,255,0.03)' }, horzLines: { color: 'rgba(255,255,255,0.04)' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.22 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: { horzLine: { color: 'rgba(255,255,255,0.2)' }, vertLine: { color: 'rgba(255,255,255,0.2)' } },
      localization: { priceFormatter: (p: number) => usdPrecise(p) },
    });
    candles.current = c.addSeries(CandlestickSeries, {
      upColor: '#36d42a', downColor: '#ff6b5b', borderVisible: false, wickUpColor: '#36d42a', wickDownColor: '#ff6b5b',
      priceFormat: { type: 'custom', formatter: (p: number) => usdPrecise(p), minMove: 1e-12 },
    });
    volume.current = c.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' } });
    c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    chart.current = c;
    return () => c.remove();
  }, []);

  // Refetch candles when the interval changes.
  useEffect(() => {
    if (interval === '1m') return setData(initial);
    const hours = interval === '1h' ? 24 * 7 : interval === '15m' ? 72 : 24;
    const ctl = new AbortController();
    fetch(`${API_URL}/tokens/${address}/candles?interval=${interval}&hours=${hours}`, { signal: ctl.signal })
      .then((r) => r.json() as Promise<{ candles: Candle[] }>)
      .then((d) => setData(d.candles ?? []))
      .catch(() => undefined);
    return () => ctl.abort();
  }, [interval, address, initial]);

  // Draw the full series whenever data, interval or mode changes.
  useEffect(() => {
    const series = continuous(data);
    candles.current?.setData(
      series.map((k) => ({
        time: k.time as UTCTimestamp, open: k.open * scale, high: k.high * scale, low: k.low * scale, close: k.close * scale,
      })),
    );
    volume.current?.setData(
      series.map((k) => ({ time: k.time as UTCTimestamp, value: k.volume, color: k.close >= k.open ? 'rgba(54,212,42,0.35)' : 'rgba(255,107,91,0.35)' })),
    );
    const tail = series[series.length - 1];
    last.current = tail ? { time: tail.time, open: tail.open, high: tail.high, low: tail.low, close: tail.close, volume: tail.volume } : null;
    seen.current = ticks.length;
    chart.current?.timeScale().fitContent();
    // ticks intentionally excluded: they are applied incrementally below
  }, [data, scale]);

  // Apply new live trades to the last candle.
  useEffect(() => {
    const fresh = ticks.slice(0, ticks.length - seen.current).reverse();
    seen.current = ticks.length;
    const step = INTERVALS[interval];
    for (const t of fresh) {
      if (!t.priceUsd) continue;
      const bucket = Math.floor(t.time / step) * step;
      const l = last.current;
      if (l && bucket < l.time) continue;
      const bar =
        l && l.time === bucket
          ? { ...l, high: Math.max(l.high, t.priceUsd), low: Math.min(l.low, t.priceUsd), close: t.priceUsd, volume: l.volume + (t.usd ?? 0) }
          : { time: bucket, open: l?.close ?? t.priceUsd, high: t.priceUsd, low: t.priceUsd, close: t.priceUsd, volume: t.usd ?? 0 };
      last.current = bar;
      candles.current?.update({
        time: bar.time as UTCTimestamp, open: bar.open * scale, high: bar.high * scale, low: bar.low * scale, close: bar.close * scale,
      });
      volume.current?.update({ time: bar.time as UTCTimestamp, value: bar.volume, color: bar.close >= bar.open ? 'rgba(54,212,42,0.35)' : 'rgba(255,107,91,0.35)' });
    }
  }, [ticks, interval, scale]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-3 py-2 text-xs">
        {(Object.keys(INTERVALS) as Interval[]).map((i) => (
          <button
            key={i}
            type="button"
            onClick={() => setIv(i)}
            className={`rounded-md px-2 py-1 font-mono ${interval === i ? 'bg-white/[0.08] text-ink' : 'text-muted hover:text-ink'}`}
          >
            {i}
          </button>
        ))}
        <div className="ml-auto flex rounded-lg bg-white/[0.04] p-0.5">
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
      <div ref={box} className="min-h-0 flex-1" />
      {!data.length && !ticks.length && (
        <p className="pointer-events-none -mt-40 mb-32 text-center text-xs text-muted">No trades in this window yet.</p>
      )}
    </div>
  );
}

/**
 * Chain candles the way GMGN/TradingView do: each one opens at the previous close, so price moves
 * between trades show up as the next candle's body instead of a visual gap. Highs and lows are
 * widened to include that open.
 */
function continuous(data: Candle[]): Candle[] {
  const out: Candle[] = [];
  let prevClose: number | null = null;
  for (const k of [...data].sort((a, b) => a.time - b.time)) {
    if (!(k.close > 0)) continue;
    const open = prevClose ?? k.open;
    out.push({ ...k, open, high: Math.max(k.high, open, k.close), low: Math.min(k.low, open, k.close) });
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

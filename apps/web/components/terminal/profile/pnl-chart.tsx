'use client';

import { useMemo, useState } from 'react';
import { usdSigned } from '@/lib/format';
import type { PnlHistory } from '@/lib/profile';

const UP = '#36d42a';
const DOWN = '#ff6b5b';
const W = 300;
const H = 100;
const PAD = 10;

const when = (t: number) =>
  new Date(t * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Cumulative realized PnL as a step line: flat between sells, a step at each one, from $0 at the range's
 * start to now. Hovering shows the running total after the nearest sell.
 */
export function PnlChart({ history, loading, label }: { history: PnlHistory | null; loading: boolean; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const chart = useMemo(() => {
    if (!history) return null;
    const now = Math.floor(Date.now() / 1000);
    const from = Math.min(history.from ?? now - 86_400, history.points[0]?.t ?? now);
    const end = Math.max(now, history.points.at(-1)?.t ?? now);
    const values = [0, ...history.points.map((p) => p.pnl)];
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const span = hi - lo || 1;
    const x = (t: number) => ((t - from) / Math.max(1, end - from)) * W;
    const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
    let line = `M0 ${y(0)}`;
    for (const p of history.points) line += ` H${x(p.t)} V${y(p.pnl)}`;
    line += ` H${W}`;
    const last = history.points.at(-1)?.pnl ?? 0;
    return { x, y, line, area: `${line} V${y(0)} H0 Z`, zero: y(0), last, up: last >= 0 };
  }, [history]);

  const pts = history?.points ?? [];
  const tip = hover != null && chart ? pts[hover] : null;
  const color = chart?.up === false ? DOWN : UP;

  return (
    <div
      className="relative mt-3 h-32 overflow-hidden rounded-xl border border-white/[0.04] bg-bg"
      onPointerMove={(e) => {
        if (!chart || !pts.length) return;
        const r = e.currentTarget.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        let best = 0;
        for (let i = 1; i < pts.length; i++) if (Math.abs(chart.x(pts[i]!.t) - px) < Math.abs(chart.x(pts[best]!.t) - px)) best = i;
        setHover(best);
      }}
      onPointerLeave={() => setHover(null)}
    >
      {chart ? (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full" role="img" aria-label={`${label}: ${usdSigned(chart.last)}`}>
          <defs>
            <linearGradient id="pnl-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.22" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`M0 ${chart.zero} H${W}`} stroke="white" strokeOpacity="0.12" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
          <path d={chart.area} fill="url(#pnl-fill)" />
          <path d={chart.line} stroke={color} strokeWidth="1.75" fill="none" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          {tip && <path d={`M${chart.x(tip.t)} 0 V${H}`} stroke="white" strokeOpacity="0.25" vectorEffect="non-scaling-stroke" />}
        </svg>
      ) : (
        <div className={`absolute inset-x-3 top-1/2 h-px bg-white/[0.06] ${loading ? 'animate-pulse' : ''}`} />
      )}
      {tip ? (
        <span className="pointer-events-none absolute left-3 top-2 rounded-md bg-surface-2/90 px-2 py-1 font-mono text-[11px]">
          <span className={tip.pnl >= 0 ? 'text-brand' : 'text-risk-high'}>{usdSigned(tip.pnl)}</span>
          <span className="ml-2 text-muted">{when(tip.t)}</span>
        </span>
      ) : (
        <span className="pointer-events-none absolute left-3 top-2 text-[10px] uppercase tracking-wider text-muted">{label}</span>
      )}
      {history && !pts.length && !loading && (
        <span className="absolute bottom-2 right-3 text-[11px] text-muted">No closed trades in this range yet</span>
      )}
    </div>
  );
}

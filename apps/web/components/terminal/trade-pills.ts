import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, SeriesType, Time } from 'lightweight-charts';
import { avatarSpec, initialOf } from './avatar';

type Target = Parameters<IPrimitivePaneRenderer['draw']>[0];

export interface Pill {
  /** The candle's time (already snapped to the interval). */
  time: number;
  side: 'buy' | 'sell';
  count: number;
  pending: boolean;
}

const BUY = '#36d42a';
const SELL = '#ff6b5b';

/**
 * Trade pills drawn on the candle series: a filled "B" under the candle's low for buys,
 * an "S" over its high for sells (with a count when several land in one candle). A series primitive
 * rather than built-in markers, which draw the letter beside a dot instead of inside a pill.
 */
export class TradePills implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private request: (() => void) | null = null;
  private items: Pill[] = [];
  private readonly view: IPrimitivePaneView;

  constructor(private readonly barAt: (time: number) => { high: number; low: number } | undefined) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.view = { zOrder: () => 'top', renderer: () => renderer };
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart;
    this.series = p.series;
    this.request = p.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.request = null;
  }

  set(items: Pill[]) {
    this.items = items;
    this.request?.();
  }

  updateAllViews() {}

  paneViews() {
    return [this.view];
  }

  private draw(target: Target) {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series || !this.items.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      const h = 15 * vr;
      const gap = 5 * vr;
      ctx.font = `700 ${Math.round(9.5 * vr)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const it of this.items) {
        const x = chart.timeScale().timeToCoordinate(it.time as Time);
        const bar = this.barAt(it.time);
        if (x == null || !bar) continue;
        const y = series.priceToCoordinate(it.side === 'buy' ? bar.low : bar.high);
        if (y == null) continue;
        const label = `${it.side === 'buy' ? 'B' : 'S'}${it.count > 1 ? it.count : ''}`;
        const w = Math.max(h, ctx.measureText(label).width + 8 * hr);
        const cx = x * hr;
        const top = it.side === 'buy' ? y * vr + gap : y * vr - gap - h;
        ctx.globalAlpha = it.pending ? 0.55 : 1;
        ctx.fillStyle = it.side === 'buy' ? BUY : SELL;
        ctx.beginPath();
        ctx.roundRect(cx - w / 2, top, w, h, h / 2);
        ctx.fill();
        ctx.fillStyle = '#0b0d0b';
        ctx.fillText(label, cx, top + h / 2 + 0.5 * vr);
      }
      ctx.globalAlpha = 1;
    });
  }
}

export interface CallMark {
  id: string;
  /** The candle's time (already snapped to the interval). */
  time: number;
  /** Price (or market cap) at the call, in the series' units. */
  value: number;
  stance: 'bullish' | 'bearish';
  /** The author's handle (its initial is drawn on the generated avatar). */
  handle: string;
  /** Seed for the generated avatar (see member-avatar.tsx), so it matches the author's avatar elsewhere. */
  seed: string;
  /** The author's uploaded avatar (already proxied), drawn instead of the generated one once loaded. */
  imageSrc: string | null;
  selected: boolean;
}

/** Marker radius in CSS pixels. */
export const CALL_RADIUS = 9;
const CALL_RADIUS_SELECTED = 11.5;

// Uploaded avatars, loaded once per page and shared by every chart.
const images = new Map<string, HTMLImageElement>();
function imageFor(src: string, onLoad: () => void): HTMLImageElement | null {
  let img = images.get(src);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.onload = onLoad;
    img.src = src;
    images.set(src, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}

/**
 * Members' calls on the chart: the author's avatar (uploaded image, else the same generated avatar
 * as everywhere else) at the call's time and price, ringed in the stance colour, larger with a white
 * ring when selected. Separate from the B/S trade pills.
 */
export class CallMarks implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private request: (() => void) | null = null;
  private items: CallMark[] = [];
  private readonly view: IPrimitivePaneView;

  constructor() {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.view = { zOrder: () => 'top', renderer: () => renderer };
  }

  attached(p: SeriesAttachedParameter<Time>) {
    this.chart = p.chart;
    this.series = p.series;
    this.request = p.requestUpdate;
  }

  detached() {
    this.chart = null;
    this.series = null;
    this.request = null;
  }

  set(items: CallMark[]) {
    this.items = items;
    this.request?.();
  }

  updateAllViews() {}

  paneViews() {
    return [this.view];
  }

  /** The call marker under a point (CSS pixels in the pane), with its centre, for hover cards. */
  hit(px: number, py: number): { item: CallMark; x: number; y: number } | null {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) return null;
    let best: { item: CallMark; x: number; y: number; d: number } | null = null;
    for (const it of this.items) {
      const x = chart.timeScale().timeToCoordinate(it.time as Time);
      const y = series.priceToCoordinate(it.value);
      if (x == null || y == null) continue;
      const d = Math.hypot(px - x, py - y);
      const r = (it.selected ? CALL_RADIUS_SELECTED : CALL_RADIUS) + 3;
      if (d <= r && (!best || d < best.d)) best = { item: it, x, y, d };
    }
    return best && { item: best.item, x: best.x, y: best.y };
  }

  private draw(target: Target) {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series || !this.items.length) return;
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      // Selected last, so it sits on top.
      const ordered = [...this.items].sort((a, b) => Number(a.selected) - Number(b.selected));
      for (const it of ordered) {
        const x = chart.timeScale().timeToCoordinate(it.time as Time);
        const y = series.priceToCoordinate(it.value);
        if (x == null || y == null) continue;
        const r = (it.selected ? CALL_RADIUS_SELECTED : CALL_RADIUS) * vr;
        const cx = x * hr;
        const cy = y * vr;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.clip();
        const img = it.imageSrc ? imageFor(it.imageSrc, () => this.request?.()) : null;
        if (img) {
          ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
        } else {
          // Same recipe as GeneratedAvatar (avatar.tsx) on a 40-unit square.
          const { from, to, angle, cells } = avatarSpec(it.seed);
          const unit = (r * 2) / 40;
          const ox = cx - r;
          const oy = cy - r;
          const rad = (angle * Math.PI) / 180;
          const dx = Math.cos(rad) * r;
          const dy = Math.sin(rad) * r;
          const g = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
          g.addColorStop(0, from);
          g.addColorStop(1, to);
          ctx.fillStyle = g;
          ctx.fillRect(ox, oy, r * 2, r * 2);
          ctx.fillStyle = 'rgba(255,255,255,0.11)';
          for (const [c, row] of cells) ctx.fillRect(ox + (5 + c * 6.2) * unit, oy + (5 + row * 6.2) * unit, 5.2 * unit, 5.2 * unit);
          ctx.fillStyle = 'rgba(255,255,255,0.07)';
          ctx.beginPath();
          ctx.arc(ox + 13 * unit, oy + 10 * unit, 16 * unit, 0, Math.PI * 2);
          ctx.fill();
          ctx.font = `700 ${Math.round(18 * unit)}px ui-sans-serif, system-ui, sans-serif`;
          ctx.fillStyle = '#ffffff';
          ctx.fillText(initialOf(it.handle), cx, cy + 0.6 * unit);
        }
        ctx.restore();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.lineWidth = (it.selected ? 2.5 : 2) * vr;
        ctx.strokeStyle = it.selected ? '#ffffff' : it.stance === 'bullish' ? BUY : SELL;
        ctx.stroke();
      }
    });
  }
}

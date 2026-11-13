import type { IChartApi, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, SeriesAttachedParameter, SeriesType, Time } from 'lightweight-charts';

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
 * GMGN-style trade pills drawn on the candle series: a filled "B" under the candle's low for buys,
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

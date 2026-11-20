'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, MagnifyingGlass } from '@phosphor-icons/react';
import { countFmt, hue, pctSigned, usd } from '@/lib/format';
import { getStocks, stockPrice, STOCKS_REFRESH_MS, type PairedRow, type StockRow, type StocksData } from '@/lib/stocks';
import { TokenAvatar } from './bits';

/**
 * /stocks: Robinhood's tokenized stocks on Robinhood Chain (identified by issuer, see packages/core/src/stocks.ts),
 * the featured one ($ANT) on top with a 24h chart and a Buy button into the token page's trade flow, then every
 * stock as a sortable list. Refreshes every 30s while the tab is visible.
 */

type SortKey = 'volume' | 'mcap' | 'change' | 'liquidity';
const SORTS: { id: SortKey; label: string; get: (s: StockRow) => number | null }[] = [
  { id: 'volume', label: '24h volume', get: (s) => s.volume_24h_usd },
  { id: 'mcap', label: 'Market cap', get: (s) => s.market_cap_usd },
  { id: 'change', label: '24h change', get: (s) => s.change_24h_pct },
  { id: 'liquidity', label: 'Liquidity', get: (s) => s.liquidity_usd },
];

/** Stock | price | 24h | chart | market cap | volume | liquidity; phones: stock | price + 24h. */
const GRID = 'grid grid-cols-[1fr_auto] items-center gap-3 md:grid-cols-[minmax(0,1fr)_6.5rem_5rem_6rem_6.5rem_6.5rem_6.5rem] md:gap-4';

export function StocksView({ initial }: { initial: StocksData | null }) {
  const data = useLiveStocks(initial);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('volume');
  const featured = data?.stocks.find((s) => s.address === data.featured) ?? null;
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const get = SORTS.find((s) => s.id === sort)!.get;
    return (data?.stocks ?? [])
      .filter((s) => !needle || s.symbol.toLowerCase().includes(needle) || s.company.toLowerCase().includes(needle))
      .sort((a, b) => (get(b) ?? -Infinity) - (get(a) ?? -Infinity));
  }, [data, q, sort]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-6 md:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-[-0.03em]">Stocks</h1>
          <span className="rounded-md bg-white/[0.06] px-2 py-0.5 text-xs text-muted">Robinhood Chain</span>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Tokenized stocks issued on Robinhood Chain, traded on-chain against USDG. Rushr is an independent app, not affiliated with Robinhood.
        </p>

        {!data && <Empty title="Couldn't load stocks" text="Check your connection and try again in a moment." />}
        {featured && <Featured s={featured} paired={data?.paired ?? []} />}

        {data && (
          <>
            <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold">All stocks</h2>
                <span className="font-mono text-xs text-muted">{data.stocks.length}</span>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <label className="relative min-w-0 flex-1 sm:w-56 sm:flex-none">
                  <MagnifyingGlass size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
                  <input
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Ticker or company"
                    aria-label="Filter stocks"
                    className="w-full rounded-lg border border-white/[0.06] bg-surface py-1.5 pl-8 pr-2 text-sm outline-none placeholder:text-muted focus:border-white/15"
                  />
                </label>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  aria-label="Sort by"
                  className="rounded-lg border border-white/[0.06] bg-surface px-2 py-1.5 text-sm text-ink outline-none md:hidden"
                >
                  {SORTS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="mt-3 overflow-hidden rounded-2xl border border-white/[0.06] bg-surface">
              <div className={`${GRID} border-b border-white/[0.06] px-4 py-3 text-xs text-muted`}>
                <span>Stock</span>
                <span className="text-right">Price</span>
                <SortHead id="change" sort={sort} onSort={setSort}>24h</SortHead>
                <span className="hidden text-right md:block">24h chart</span>
                <SortHead id="mcap" sort={sort} onSort={setSort}>Market cap</SortHead>
                <SortHead id="volume" sort={sort} onSort={setSort}>Volume</SortHead>
                <SortHead id="liquidity" sort={sort} onSort={setSort}>Liquidity</SortHead>
              </div>
              {rows.length === 0 ? (
                <Empty title="No stock matches" text="Try a ticker like ANT, NVDA or SPY." />
              ) : (
                <ol>
                  {rows.map((s) => (
                    <li key={s.address} className="border-b border-white/[0.04] last:border-0">
                      <Link href={`/token/${s.address}`} className={`${GRID} px-4 py-3 transition hover:bg-white/[0.03]`}>
                        <span className="flex min-w-0 items-center gap-3">
                          <StockLogo s={s} size={36} />
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold">{s.symbol}</span>
                            <span className="block truncate text-xs text-muted">{s.company}</span>
                          </span>
                        </span>
                        <span className="text-right font-mono text-sm">
                          {stockPrice(s.price_usd)}
                          <Change v={s.change_24h_pct} className="block text-xs md:hidden" />
                        </span>
                        <Change v={s.change_24h_pct} className="hidden text-right text-sm md:block" />
                        <span className="hidden justify-end md:flex">
                          <Sparkline points={s.spark} up={isUp(s)} width={96} height={28} />
                        </span>
                        <span className="hidden text-right font-mono text-sm md:block">{usd(s.market_cap_usd)}</span>
                        <span className="hidden text-right font-mono text-sm md:block">{usd(s.volume_24h_usd)}</span>
                        <span className="hidden text-right font-mono text-sm md:block">{usd(s.liquidity_usd)}</span>
                      </Link>
                    </li>
                  ))}
                </ol>
              )}
            </div>
            <p className="mt-3 text-xs text-muted">
              Prices and volume come from on-chain trades on Robinhood Chain and can differ from the exchange-listed share. A token is listed here only when Robinhood&apos;s
              stock-token issuer deployed it, so look-alikes using the same name are left out.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function Featured({ s, paired }: { s: StockRow; paired: PairedRow[] }) {
  const up = isUp(s);
  return (
    <section className="mt-5 overflow-hidden rounded-2xl border border-white/[0.08] bg-surface">
      <div className="grid gap-5 p-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:p-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <StockLogo s={s} size={48} />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold">${s.symbol}</span>
                <span className="rounded-full border border-brand/30 bg-brand/10 px-2 py-px text-[10px] font-medium uppercase tracking-wider text-brand">Featured</span>
              </div>
              <div className="truncate text-sm text-muted">{s.company}</div>
            </div>
          </div>
          <div className="mt-4 flex items-baseline gap-3">
            <span className="font-mono text-3xl font-semibold tracking-[-0.02em]">{stockPrice(s.price_usd)}</span>
            {s.change_24h_pct != null && <Change v={s.change_24h_pct} className="font-mono text-sm" suffix=" 24h" />}
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4 md:grid-cols-2 lg:grid-cols-4">
            <Stat label="Market cap" value={usd(s.market_cap_usd)} />
            <Stat label="24h volume" value={usd(s.volume_24h_usd)} />
            <Stat label="Liquidity" value={usd(s.liquidity_usd)} />
            <Stat label="Holders" value={countFmt(s.holders)} />
          </dl>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link
              href={`/token/${s.address}`}
              className="inline-flex items-center gap-2 rounded-xl bg-go px-5 py-2.5 text-sm font-semibold text-[#0b120c] transition hover:brightness-105 active:scale-[0.98]"
            >
              Buy ${s.symbol}
              <ArrowRight size={14} weight="bold" />
            </Link>
            <Link href={`/token/${s.address}`} className="inline-flex items-center rounded-xl border border-white/10 px-4 py-2.5 text-sm text-muted transition hover:text-ink">
              Chart and trades
            </Link>
          </div>
        </div>
        <div className="flex min-w-0 flex-col justify-end">
          <div className="mb-1 flex justify-between text-[11px] text-muted">
            <span>Last 24h</span>
            <span>hourly</span>
          </div>
          <Sparkline points={s.spark} up={up} width={520} height={150} fill className="h-28 w-full md:h-44" />
        </div>
      </div>
      {paired.length > 0 && (
        <div className="border-t border-white/[0.06] px-4 py-3 md:px-6">
          <div className="text-xs text-muted">
            Memecoins priced in ${s.symbol} <span className="opacity-70">· community launches, not stocks</span>
          </div>
          <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
            {paired.map((p) => (
              <Link
                key={p.address}
                href={`/token/${p.address}`}
                className="flex shrink-0 items-center gap-2 rounded-xl border border-white/[0.06] bg-surface-2 px-2.5 py-1.5 text-sm transition hover:border-white/15"
              >
                <TokenAvatar t={{ address: p.address, symbol: p.symbol, launchpad: p.launchpad, image_url: p.image_url }} size={22} />
                <span className="font-semibold">{p.symbol}</span>
                <span className="font-mono text-xs text-muted">{usd(p.market_cap_usd)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** Green or red: the 24h change, or the chart's own direction while there's no 24h figure yet. */
const isUp = (s: Pick<StockRow, 'change_24h_pct' | 'spark'>) =>
  s.change_24h_pct != null ? s.change_24h_pct >= 0 : s.spark.length < 2 || s.spark[s.spark.length - 1]! >= s.spark[0]!;

/** The token's icon when it has one, else a ticker tile (most stock tokens carry no icon metadata). */
function StockLogo({ s, size }: { s: Pick<StockRow, 'address' | 'symbol' | 'image_url'>; size: number }) {
  if (s.image_url) return <TokenAvatar t={{ address: s.address, symbol: s.symbol, launchpad: null, image_url: s.image_url }} size={size} shape="square" />;
  const c = hue(s.address);
  const text = s.symbol.slice(0, 4);
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-[22%] border font-mono font-semibold tracking-[-0.04em]"
      style={{ width: size, height: size, color: c, borderColor: `${c}40`, background: `${c}14`, fontSize: size * (text.length > 3 ? 0.27 : 0.32) }}
    >
      {text}
    </span>
  );
}

function Sparkline({ points, up, width, height, fill = false, className }: { points: number[]; up: boolean; width: number; height: number; fill?: boolean; className?: string }) {
  if (points.length < 2) {
    return (
      <span className={`flex items-center justify-center text-[11px] text-muted ${className ?? ''}`} style={className ? undefined : { width, height }}>
        {fill ? 'Chart fills in as trades come in' : '—'}
      </span>
    );
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const pad = 2;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * width, pad + (1 - (p - min) / span) * (height - pad * 2)] as const);
  const line = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const color = up ? 'var(--color-brand)' : 'var(--color-risk-high)';
  const id = `spark-${up ? 'up' : 'down'}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" width={className ? undefined : width} height={className ? undefined : height} className={className} aria-hidden>
      {fill && (
        <>
          <defs>
            <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.22" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${line} L${width} ${height} L0 ${height} Z`} fill={`url(#${id})`} />
        </>
      )}
      <path d={line} fill="none" stroke={color} strokeWidth={fill ? 2 : 1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Change({ v, className = '', suffix = '' }: { v: number | null; className?: string; suffix?: string }) {
  const tone = v == null ? 'text-muted' : v >= 0 ? 'text-brand' : 'text-risk-high';
  return (
    <span className={`font-mono ${tone} ${className}`} title={v == null ? 'Not enough price history yet for a 24h change' : undefined}>
      {pctSigned(v, 2)}
      {v != null && suffix}
    </span>
  );
}

function SortHead({ id, sort, onSort, children }: { id: SortKey; sort: SortKey; onSort: (k: SortKey) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => onSort(id)}
      aria-pressed={sort === id}
      className={`hidden text-right transition hover:text-ink md:block ${sort === id ? 'text-ink' : ''}`}
    >
      {children}
      {sort === id && ' ↓'}
    </button>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] text-muted">{label}</dt>
      <dd className="font-mono text-sm font-semibold">{value}</dd>
    </div>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="px-4 py-12 text-center">
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1 text-sm text-muted">{text}</div>
    </div>
  );
}

/** The server's list, refreshed every 30s while the tab is visible. */
function useLiveStocks(initial: StocksData | null) {
  const [data, setData] = useState(initial);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (document.visibilityState !== 'visible') return;
      const next = await getStocks(0);
      if (next && !stop) setData(next);
    };
    if (!initial) void tick();
    const id = setInterval(tick, STOCKS_REFRESH_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [initial]);
  return data;
}

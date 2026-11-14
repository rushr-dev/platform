'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowSquareOut, Funnel, PauseCircle, X } from '@phosphor-icons/react';
import { age, compact, EXPLORER, price, short, usd } from '@/lib/format';
import { useNow } from '@/lib/now';
import { makerTags, type MakerContext, type MakerTag, type Tx } from '@/lib/trades';
import { TagChip, TagList, TAG_META } from './tags';

/** Rows share tags when the maker, the whale-size flag and the server's tags match. */
const tagKey = (t: Tx) => `${t.trader}:${(t.usd ?? 0) >= 2500 ? 1 : 0}:${t.tags?.join(',') ?? ''}`;

const FILTER_TAGS: MakerTag[] = ['whale', 'dev', 'top10', 'sniper', 'bundler', 'insider', 'fresh'];
const SHOW = 200;

/**
 * GMGN-style trades: rows slide in live, ages tick, makers carry tags. Hovering the table holds the
 * list still (new trades queue up behind a pill) so a row doesn't move under the cursor.
 */
export function TradesTable({
  trades,
  ctx,
  supply,
  serverNow,
  maker,
  onMaker,
}: {
  trades: Tx[] | null;
  ctx: MakerContext;
  supply: number;
  serverNow: number;
  maker: string | null;
  onMaker: (wallet: string | null) => void;
}) {
  const [side, setSide] = useState<'all' | 'buy' | 'sell'>('all');
  const [tags, setTags] = useState<MakerTag[]>([]);
  const [minUsd, setMinUsd] = useState(0);
  const [showFilters, setShowFilters] = useState(false);
  const [mcap, setMcap] = useState(true);
  const [frozen, setFrozen] = useState<Tx[] | null>(null);
  // Rows that arrive after the first paint get an entrance animation.
  const firstPaint = useRef<Set<string> | null>(null);
  if (trades && !firstPaint.current) firstPaint.current = new Set(trades.map((t) => t.id));

  const tagged = useMemo(() => {
    const m = new Map<string, MakerTag[]>();
    for (const t of trades ?? []) {
      const key = tagKey(t);
      if (!m.has(key)) m.set(key, makerTags(t.trader, ctx, t.usd, t.tags));
    }
    return m;
  }, [trades, ctx]);
  const tagsOf = useCallback((t: Tx) => tagged.get(tagKey(t)) ?? [], [tagged]);

  const filter = useCallback(
    (list: Tx[]) =>
      list.filter((t) => {
        if (side !== 'all' && t.side !== side) return false;
        if (minUsd && (t.usd ?? 0) < minUsd) return false;
        if (maker && t.trader !== maker) return false;
        if (tags.length) {
          const mine = tagsOf(t);
          if (!tags.some((x) => mine.includes(x))) return false;
        }
        return true;
      }),
    [side, minUsd, maker, tags, tagsOf],
  );

  const live = useMemo(() => filter(trades ?? []), [trades, filter]);
  const shown = frozen ? filter(frozen) : live;
  const queued = frozen ? live.length - shown.length : 0;
  const nFilters = (side !== 'all' ? 1 : 0) + tags.length + (minUsd ? 1 : 0) + (maker ? 1 : 0);

  if (!trades) return <TableSkeleton />;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.04] px-3 py-1.5 text-[11px]">
        <div className="flex rounded-lg bg-white/[0.04] p-0.5">
          {(['all', 'buy', 'sell'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSide(s)}
              className={`rounded-md px-2 py-0.5 capitalize ${
                side === s ? (s === 'buy' ? 'bg-brand/20 text-brand' : s === 'sell' ? 'bg-risk-high/20 text-risk-high' : 'bg-white/[0.1] text-ink') : 'text-muted'
              }`}
            >
              {s === 'all' ? 'All' : `${s}s`}
            </button>
          ))}
        </div>
        <div className="hidden items-center gap-1 sm:flex">
          {FILTER_TAGS.map((tag) => (
            <TagToggle key={tag} tag={tag} on={tags.includes(tag)} onClick={() => setTags((p) => (p.includes(tag) ? p.filter((x) => x !== tag) : [...p, tag]))} />
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowFilters((s) => !s)}
          className={`flex items-center gap-1 rounded-lg px-2 py-0.5 ${showFilters || minUsd ? 'bg-white/[0.08] text-ink' : 'text-muted hover:text-ink'}`}
        >
          <Funnel size={11} weight={minUsd ? 'fill' : 'regular'} /> <span className="sm:hidden">Filter</span>
          <span className="hidden sm:inline">Min $</span>
          {minUsd ? ` ${usd(minUsd)}` : ''}
        </button>
        {maker && (
          <button type="button" onClick={() => onMaker(null)} className="flex items-center gap-1 rounded-lg bg-brand/15 px-2 py-0.5 font-mono text-brand">
            {short(maker)} <X size={10} weight="bold" />
          </button>
        )}
        {nFilters > 0 && (
          <button
            type="button"
            onClick={() => {
              setSide('all');
              setTags([]);
              setMinUsd(0);
              onMaker(null);
            }}
            className="text-muted hover:text-ink"
          >
            Clear
          </button>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-muted">
          {frozen ? (
            <span className="flex items-center gap-1 text-risk-medium">
              <PauseCircle size={12} weight="fill" /> Paused{queued > 0 ? ` · ${queued} new` : ''}
            </span>
          ) : (
            <>
              <span className="size-1.5 animate-pulse rounded-full bg-brand" /> Live
            </>
          )}
        </span>
      </div>
      {showFilters && (
        <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.04] px-3 py-2 text-[11px]">
          <span className="text-muted">Min trade</span>
          {[0, 50, 250, 1000, 5000].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setMinUsd(v)}
              className={`rounded-md px-2 py-0.5 font-mono ${minUsd === v ? 'bg-white/[0.1] text-ink' : 'text-muted hover:text-ink'}`}
            >
              {v ? usd(v) : 'Any'}
            </button>
          ))}
          <div className="flex flex-wrap gap-1 sm:hidden">
            {FILTER_TAGS.map((tag) => (
              <TagToggle key={tag} tag={tag} on={tags.includes(tag)} onClick={() => setTags((p) => (p.includes(tag) ? p.filter((x) => x !== tag) : [...p, tag]))} />
            ))}
          </div>
        </div>
      )}
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]"
        onMouseEnter={(e) => {
          // Mouse only: touch scrolling shouldn't freeze the list.
          if (window.matchMedia('(hover: hover)').matches && e.currentTarget.scrollTop >= 0) setFrozen(trades);
        }}
        onMouseLeave={() => setFrozen(null)}
      >
        {shown.length === 0 ? (
          <div className="grid h-40 place-items-center text-sm text-muted">{trades.length ? 'No trades match these filters.' : 'No trades yet.'}</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 z-10 bg-surface text-left text-[11px] text-muted">
              <tr>
                <th className="py-2 pl-3 font-normal">Age</th>
                <th className="py-2 font-normal">Type</th>
                <th className="py-2 pr-2 text-right font-normal">USD</th>
                <th className="hidden py-2 pr-2 text-right font-normal sm:table-cell">Amount</th>
                <th className="hidden py-2 pr-2 text-right font-normal md:table-cell">
                  <button type="button" onClick={() => setMcap((m) => !m)} className="hover:text-ink" title="Switch price / market cap">
                    {mcap ? 'MC' : 'Price'} ⇄
                  </button>
                </th>
                <th className="py-2 pl-2 font-normal">Maker</th>
                <th className="w-8 py-2 pr-3 font-normal" />
              </tr>
            </thead>
            <tbody className="font-mono">
              {shown.slice(0, SHOW).map((x) => (
                <Row
                  key={x.id}
                  x={x}
                  tags={tagsOf(x)}
                  mcap={mcap}
                  supply={supply}
                  serverNow={serverNow}
                  animate={!firstPaint.current?.has(x.id)}
                  active={maker === x.trader}
                  onMaker={onMaker}
                />
              ))}
            </tbody>
          </table>
        )}
        {shown.length > SHOW && <p className="py-3 text-center text-[11px] text-muted">Showing the latest {SHOW} of {shown.length} trades.</p>}
      </div>
    </div>
  );
}

function TagToggle({ tag, on, onClick }: { tag: MakerTag; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={TAG_META[tag].title}
      className={`rounded-md transition ${on ? 'ring-1 ring-white/40' : 'opacity-60 hover:opacity-100'}`}
    >
      <TagChip tag={tag} />
    </button>
  );
}

/** Ticks once a second on its own, so the table around it doesn't re-render. */
function Age({ time, serverNow }: { time: number; serverNow: number }) {
  const now = useNow(serverNow);
  return <>{age(time * 1000, now)}</>;
}

function flash(el: HTMLTableRowElement | null, side: 'buy' | 'sell') {
  if (!el || typeof el.animate !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const tint = side === 'buy' ? 'rgba(54,212,42,0.18)' : 'rgba(255,107,91,0.18)';
  el.animate([{ backgroundColor: tint, opacity: 0.3 }, { backgroundColor: tint, opacity: 1, offset: 0.15 }, { backgroundColor: 'transparent' }], {
    duration: 1400,
    easing: 'ease-out',
  });
}

const Row = memo(function Row({
  x,
  tags,
  mcap,
  supply,
  serverNow,
  animate,
  active,
  onMaker,
}: {
  x: Tx;
  tags: MakerTag[];
  mcap: boolean;
  supply: number;
  serverNow: number;
  animate: boolean;
  active: boolean;
  onMaker: (wallet: string | null) => void;
}) {
  const buy = x.side === 'buy';
  const tone = buy ? 'text-brand' : 'text-risk-high';
  const big = (x.usd ?? 0) >= 1000;
  const ref = useRef<HTMLTableRowElement>(null);
  // Mount only: a row animates once, when it first appears.
  useEffect(() => {
    if (animate) flash(ref.current, x.side);
  }, []);
  return (
    <tr ref={ref} className={`border-t border-white/[0.03] hover:bg-white/[0.025] ${active ? 'bg-white/[0.04]' : ''}`}>
      <td className="whitespace-nowrap py-1.5 pl-3 text-muted">
        <Age time={x.time} serverNow={serverNow} />
      </td>
      <td className={tone}>{buy ? 'Buy' : 'Sell'}</td>
      <td className={`pr-2 text-right ${tone} ${big ? 'font-semibold' : ''}`}>{usd(x.usd)}</td>
      <td className="hidden pr-2 text-right text-ink/80 sm:table-cell">{compact(x.tokens)}</td>
      <td className="hidden pr-2 text-right text-ink/70 md:table-cell">{mcap ? usd(x.priceUsd && supply ? x.priceUsd * supply : null) : price(x.priceUsd)}</td>
      <td className="py-1 pl-2">
        <span className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => onMaker(active ? null : x.trader)}
            title={active ? 'Show all makers' : 'Only this maker'}
            className={`hover:text-ink ${active ? 'text-brand' : 'text-ink/75'}`}
          >
            {short(x.trader, 3, 4)}
          </button>
          <TagList tags={tags} compact max={3} />
        </span>
      </td>
      <td className="pr-3 text-right">
        <a href={`${EXPLORER}/tx/${x.tx}`} target="_blank" rel="noreferrer" aria-label="Open transaction" className="text-muted hover:text-ink">
          <ArrowSquareOut size={12} />
        </a>
      </td>
    </tr>
  );
});

export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-6 animate-pulse rounded-md bg-white/[0.04]" style={{ opacity: 1 - i * 0.08 }} />
      ))}
    </div>
  );
}

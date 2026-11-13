'use client';

import Link from 'next/link';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Funnel,
  Lightning,
  MagnifyingGlass,
  PauseCircle,
  Plant,
  RocketLaunch,
  Sparkle,
  X,
} from '@phosphor-icons/react';
import type { Column, TokenCard } from '@/lib/api';
import { age, compact, LAUNCHPAD_LABEL, pct, quoteLabel, usd } from '@/lib/format';
import { useTopic, useTopicDeltas } from '@/lib/feed/react';
import { trenchesColumnSpec, trenchesSpec, type TrenchesState } from '@/lib/feed/topics';
import type { Delta } from '@/lib/feed/protocol';
import { useNow } from '@/lib/now';
import dynamic from 'next/dynamic';
import { tradingAvailable } from '@/components/trade/flag';

import { useSettings } from '@/lib/settings';
import { RingedAvatar, ringOf, SocialLinks } from './bits';

/** Loaded only when trading is on (one chunk shared by every row). */
const QuickBuyButton = dynamic(() => import('@/components/trade/quick-buy-button').then((m) => m.QuickBuyButton), {
  ssr: false,
  loading: () => <span className="inline-block h-6 w-16 animate-pulse rounded-lg bg-brand/10" />,
});

/* ------------------------------------------------------------------ column rules (mirror the API) */

/** Launchpads whose tokens trade on a bonding curve before graduating (mirrors the API). */
const CURVE_LAUNCHPADS = new Set(['pons', 'liftfun']);
const ALMOST_BONDED = 0.5;

function columnOf(t: TokenCard): Column {
  if (t.status === 'migrated') return 'migrated';
  // Only curve tokens can be "almost bonded"; a plain pool has no curve, whatever its market cap.
  const almost = CURVE_LAUNCHPADS.has(t.launchpad ?? '') && (t.bonding_progress ?? 0) >= ALMOST_BONDED;
  return almost ? 'almost' : 'new';
}

const ts = (s: string | null | undefined) => (s ? new Date(s).getTime() : 0);
const SORT: Record<Column, (a: TokenCard, b: TokenCard) => number> = {
  new: (a, b) => ts(b.created_at) - ts(a.created_at),
  almost: (a, b) =>
    (b.bonding_progress ?? -1) - (a.bonding_progress ?? -1) || (b.market_cap_usd ?? 0) - (a.market_cap_usd ?? 0),
  migrated: (a, b) => ts(b.migrated_at ?? b.created_at) - ts(a.migrated_at ?? a.created_at),
};

type SortKey = 'default' | 'newest' | 'mcap' | 'volume' | 'holders' | 'txns';
const SORT_LABEL: Record<SortKey, string> = { default: 'Default', newest: 'Newest', mcap: 'Market cap', volume: 'Volume', holders: 'Holders', txns: 'Transactions' };
const BY: Record<Exclude<SortKey, 'default'>, (a: TokenCard, b: TokenCard) => number> = {
  newest: (a, b) => ts(b.created_at) - ts(a.created_at),
  mcap: (a, b) => (b.market_cap_usd ?? b.initial_market_cap_usd ?? 0) - (a.market_cap_usd ?? a.initial_market_cap_usd ?? 0),
  volume: (a, b) => (b.volume_24h_usd ?? 0) - (a.volume_24h_usd ?? 0),
  holders: (a, b) => b.holders - a.holders,
  txns: (a, b) => ((b.buys_24h ?? 0) + (b.sells_24h ?? 0) || (b.trades_24h ?? 0)) - ((a.buys_24h ?? 0) + (a.sells_24h ?? 0) || (a.trades_24h ?? 0)),
};
const SORTS_KEY = 'rushr.trenches.sort';

const COLUMNS: { id: Column; title: string; icon: typeof Plant }[] = [
  { id: 'new', title: 'New pairs', icon: Sparkle },
  { id: 'almost', title: 'Almost bonded', icon: Plant },
  { id: 'migrated', title: 'Migrated', icon: RocketLaunch },
];

const PER_COLUMN = 60;

/* ------------------------------------------------------------------ filters */

interface Filters {
  minMcap: number;
  maxMcap: number;
  minVolume: number;
  minHolders: number;
  maxAgeMin: number;
  maxTop10: number;
  maxDev: number;
  hideHighRisk: boolean;
  hideCopycat: boolean;
  hasSocial: boolean;
  launchpad: string;
  keyword: string;
}
const NO_FILTERS: Filters = {
  minMcap: 0, maxMcap: 0, minVolume: 0, minHolders: 0, maxAgeMin: 0, maxTop10: 0, maxDev: 0,
  hideHighRisk: false, hideCopycat: false, hasSocial: false, launchpad: '', keyword: '',
};
const activeCount = (f: Filters) =>
  (Object.keys(NO_FILTERS) as (keyof Filters)[]).filter((k) => f[k] !== NO_FILTERS[k]).length;

function passes(t: TokenCard, f: Filters, now: number) {
  const mc = t.market_cap_usd ?? 0;
  if (f.minMcap && mc < f.minMcap) return false;
  if (f.maxMcap && mc > f.maxMcap) return false;
  if (f.minVolume && (t.volume_24h_usd ?? 0) < f.minVolume) return false;
  if (f.minHolders && t.holders < f.minHolders) return false;
  if (f.maxAgeMin && now - ts(t.created_at) > f.maxAgeMin * 60_000) return false;
  // Unknown (not yet checked) passes the max filters; only measured values are held against a token.
  if (f.maxTop10 && (t.top10_pct ?? 0) > f.maxTop10) return false;
  if (f.maxDev && (t.dev_pct ?? 0) > f.maxDev) return false;
  if (f.hideHighRisk && t.risk === 'high') return false;
  if (f.hideCopycat && t.copycat) return false;
  if (f.hasSocial && !t.website && !t.twitter && !t.telegram) return false;
  if (f.launchpad && t.launchpad !== f.launchpad) return false;
  if (f.keyword.trim()) {
    const k = f.keyword.trim().toLowerCase();
    if (!t.symbol.toLowerCase().includes(k) && !t.name.toLowerCase().includes(k) && !t.address.startsWith(k)) return false;
  }
  return true;
}

function loadFilters(): Record<Column, Filters> {
  const base = { new: NO_FILTERS, almost: NO_FILTERS, migrated: NO_FILTERS };
  try {
    const raw = JSON.parse(localStorage.getItem('rushr.trenches.filters') ?? '{}') as Partial<Record<Column, Partial<Filters>>>;
    // Older saves lack the newer keys; fill them in.
    return { new: { ...NO_FILTERS, ...raw.new }, almost: { ...NO_FILTERS, ...raw.almost }, migrated: { ...NO_FILTERS, ...raw.migrated } };
  } catch {
    return base;
  }
}

/* ------------------------------------------------------------------ main */

export function Trenches({ initial, serverNow }: { initial: TokenCard[]; serverNow: number }) {
  // Every known token, by address: server-rendered first screen, then the HTTP snapshot and live
  // deltas from the feed client (batched once per frame there).
  // v1: one `trenches` topic, columns computed here. v2: one topic per column, membership decided by
  // the server (moves included). Both are subscribed; the v2 columns take over once all three have
  // a server snapshot. (A v2 server rejects the legacy topic; a v1 server never fills the columns.)
  const legacy = useTopic<TrenchesState>('trenches', () => trenchesSpec(initial));
  const colNew = useTopic<TrenchesState>('trenches:new', () => trenchesColumnSpec('new', initial.filter((t) => columnOf(t) === 'new')));
  const colAlmost = useTopic<TrenchesState>('trenches:almost', () => trenchesColumnSpec('almost', initial.filter((t) => columnOf(t) === 'almost')));
  const colMigrated = useTopic<TrenchesState>('trenches:migrated', () => trenchesColumnSpec('migrated', initial.filter((t) => columnOf(t) === 'migrated')));
  const serverColumns = colNew.fromServer && colAlmost.fromServer && colMigrated.fromServer;
  const tokens = legacy.data;
  const flashed = useRef(new Map<string, number>());
  // Last seen market cap per token, so a row only flashes when its number actually moves.
  const mcaps = useRef(new Map(initial.map((t) => [t.address, t.market_cap_usd])));
  // Tokens that launched while the page was open slide in; everything else just appears.
  const entering = useRef(new Set<string>());
  // Start from the server's clock so the first client render matches the HTML (ages are time-based).
  const [now, setNow] = useState(serverNow);
  const [filters, setFilters] = useState<Record<Column, Filters>>({ new: NO_FILTERS, almost: NO_FILTERS, migrated: NO_FILTERS });
  const [paused, setPaused] = useState<Partial<Record<Column, string[]>>>({});
  const [mobileCol, setMobileCol] = useState<Column>('new');
  const [showSpam, setShowSpam] = useState(false);
  const [showPlain, setShowPlain] = useState(false);
  // One-tap buy amounts (P1/P2): shared with the settings page.
  const { quickBuy: quick, quickBuy2: quick2 } = useSettings();
  const [sorts, setSorts] = useState<Record<Column, SortKey>>({ new: 'default', almost: 'default', migrated: 'default' });
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(SORTS_KEY) ?? 'null') as Partial<Record<Column, SortKey>> | null;
      if (saved) setSorts((p) => ({ ...p, ...saved }));
    } catch {
      // storage unavailable
    }
  }, []);
  const setSort = useCallback((col: Column, k: SortKey) => {
    setSorts((p) => {
      const next = { ...p, [col]: k };
      try {
        localStorage.setItem(SORTS_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable
      }
      return next;
    });
  }, []);

  useEffect(() => setFilters(loadFilters()), []);
  useEffect(() => {
    // Only the max-age filter needs this; row ages tick on their own clock.
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const onDeltas = (deltas: Delta[]) => {
    const at = Date.now();
    for (const d of deltas) {
      const payload = d.kind === 'move' ? (d.data as { card?: TokenCard } | null)?.card : d.data;
      for (const t of (Array.isArray(payload) ? payload : [payload]) as TokenCard[]) {
        if (!t?.address) continue;
        if (d.kind === 'launch') entering.current.add(t.address);
        if (d.kind === 'launch' || mcaps.current.get(t.address) !== t.market_cap_usd) flashed.current.set(t.address, at);
        mcaps.current.set(t.address, t.market_cap_usd);
      }
    }
  };
  useTopicDeltas('trenches', onDeltas);
  useTopicDeltas('trenches:new', onDeltas);
  useTopicDeltas('trenches:almost', onDeltas);
  useTopicDeltas('trenches:migrated', onDeltas);

  const lists = useMemo(() => {
    const out: Record<Column, TokenCard[]> = { new: [], almost: [], migrated: [] };
    const keep = (t: TokenCard) => (showSpam || !t.spam) && (showPlain || (t.launchpad ?? 'uniswap-v4') !== 'uniswap-v4');
    if (serverColumns) {
      const seen = new Set<string>();
      const cols: [Column, TrenchesState][] = [['new', colNew.data], ['almost', colAlmost.data], ['migrated', colMigrated.data]];
      for (const [c, m] of cols)
        for (const t of m.values()) {
          seen.add(t.address);
          // Migrated is the server's call (graduated curve tokens, dust hidden); the plain-pool toggle is for New.
          if (c === 'migrated' ? showSpam || !t.spam : keep(t)) out[c].push(t);
        }
      // The column topics carry launchpad tokens only; plain pools still come from the HTTP list.
      if (showPlain) for (const t of tokens.values()) if (!seen.has(t.address) && (t.launchpad ?? 'uniswap-v4') === 'uniswap-v4' && keep(t)) out[columnOf(t)].push(t);
    } else {
      for (const t of tokens.values()) if (keep(t)) out[columnOf(t)].push(t);
    }
    for (const c of COLUMNS) {
      const k = sorts[c.id];
      out[c.id].sort(k === 'default' ? SORT[c.id] : (a, b) => BY[k](a, b) || SORT[c.id](a, b));
    }
    return out;
  }, [tokens, serverColumns, colNew.data, colAlmost.data, colMigrated.data, showSpam, showPlain, sorts]);
  // Paused columns look tokens up by address across every source.
  const byAddress = useMemo(
    () => (serverColumns ? new Map([...tokens, ...colNew.data, ...colAlmost.data, ...colMigrated.data]) : tokens),
    [serverColumns, tokens, colNew.data, colAlmost.data, colMigrated.data],
  );

  const setColFilters = useCallback((col: Column, f: Filters) => {
    setFilters((prev) => {
      const next = { ...prev, [col]: f };
      try {
        localStorage.setItem('rushr.trenches.filters', JSON.stringify(next));
      } catch {
        // storage unavailable; filters still apply for this visit
      }
      return next;
    });
  }, []);

  return (
    <div className="flex h-full flex-col">
      <Toolbar showSpam={showSpam} onShowSpam={setShowSpam} showPlain={showPlain} onShowPlain={setShowPlain} />
      {/* Mobile: one column at a time */}
      <div className="mx-3 mb-2 flex gap-1 rounded-full border border-white/[0.07] bg-surface p-1 md:hidden">
        {COLUMNS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setMobileCol(c.id)}
            className={`flex-1 rounded-full py-2 text-xs font-semibold ${mobileCol === c.id ? 'bg-white/[0.08] text-ink' : 'text-muted'}`}
          >
            {c.title}
          </button>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 px-3 pb-3 md:grid-cols-3 md:px-4 md:pb-4">
        {COLUMNS.map((c) => {
          const f = filters[c.id];
          const live = lists[c.id].filter((t) => passes(t, f, now));
          const frozen = paused[c.id];
          const shown = frozen
            ? frozen.map((a) => byAddress.get(a)).filter((t): t is TokenCard => !!t)
            : live.slice(0, PER_COLUMN);
          const waiting = frozen ? live.filter((t) => !frozen.includes(t.address)).length : 0;
          return (
            <ColumnPanel
              key={c.id}
              col={c}
              tokens={shown}
              total={live.length}
              waiting={waiting}
              paused={!!frozen}
              flashed={flashed.current}
              entering={entering.current}
              serverNow={serverNow}
              quick={quick}
              quick2={quick2}
              sort={sorts[c.id]}
              onSort={(k) => setSort(c.id, k)}
              filters={f}
              onFilters={(next) => setColFilters(c.id, next)}
              onPause={(on) =>
                setPaused((p) => ({ ...p, [c.id]: on ? live.slice(0, PER_COLUMN).map((t) => t.address) : undefined }))
              }
              className={mobileCol === c.id ? '' : 'hidden md:flex'}
            />
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ toolbar */

function Toolbar({
  showSpam,
  onShowSpam,
  showPlain,
  onShowPlain,
}: {
  showSpam: boolean;
  onShowSpam: (v: boolean) => void;
  showPlain: boolean;
  onShowPlain: (v: boolean) => void;
}) {
  const chip = (on: boolean, onClick: () => void, label: string, title: string) => (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      title={title}
      className={`rounded-full border px-3 py-1 text-xs transition ${on ? 'border-brand/30 bg-brand/10 text-brand' : 'border-white/[0.08] text-muted hover:border-white/15 hover:text-ink'}`}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-3 pt-4 md:px-5">
      <h1 className="text-2xl font-semibold tracking-[-0.03em] md:text-3xl">Trenches</h1>
      <span className="rounded-full border border-white/[0.08] px-2.5 py-0.5 text-xs text-muted">Robinhood Chain</span>
      <div className="ml-auto flex items-center gap-1.5">
        {chip(showSpam, () => onShowSpam(!showSpam), 'Spam clones', 'Airdrop-farm clones: plain pools whose holder count was padded with mass airdrops')}
        {chip(showPlain, () => onShowPlain(!showPlain), 'Plain pools', 'Tokens launched straight into a Uniswap pool, without a launchpad. Most copycat clones live here.')}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ column */

function ColumnPanel({
  col,
  tokens,
  total,
  waiting,
  paused,
  flashed,
  entering,
  serverNow,
  quick,
  quick2,
  sort,
  onSort,
  filters,
  onFilters,
  onPause,
  className,
}: {
  col: (typeof COLUMNS)[number];
  tokens: TokenCard[];
  total: number;
  waiting: number;
  paused: boolean;
  flashed: Map<string, number>;
  entering: Set<string>;
  serverNow: number;
  quick: string;
  quick2: string;
  sort: SortKey;
  onSort: (k: SortKey) => void;
  filters: Filters;
  onFilters: (f: Filters) => void;
  onPause: (on: boolean) => void;
  className: string;
}) {
  const [showFilters, setShowFilters] = useState(false);
  const n = activeCount(filters);
  return (
    <section className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-surface ${className}`}>
      <header className="flex items-center gap-2 border-b border-white/[0.05] px-4 py-3">
        <h2 className="shrink-0 text-[15px] font-semibold">{col.title}</h2>
        <span className="font-mono text-xs text-muted">{total}</span>
        {paused ? (
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-risk-medium/15 px-2 py-0.5 text-[11px] font-medium text-risk-medium" title="Paused while you hover">
            <PauseCircle size={12} weight="fill" />
            {waiting ? `${waiting} new` : 'Paused'}
          </span>
        ) : (
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand" title="Live" />
        )}
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <label className="flex w-28 min-w-0 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.02] px-2.5 py-1 focus-within:border-white/20 xl:w-36">
            <MagnifyingGlass size={12} className="shrink-0 text-muted" />
            <input
              value={filters.keyword}
              onChange={(e) => onFilters({ ...filters, keyword: e.target.value.slice(0, 42) })}
              placeholder="Keyword"
              aria-label={`Filter ${col.title} by keyword, symbol or address`}
              className="w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-muted/80"
            />
            {filters.keyword && (
              <button type="button" onClick={() => onFilters({ ...filters, keyword: '' })} aria-label="Clear keyword" className="text-muted hover:text-ink">
                <X size={11} />
              </button>
            )}
          </label>
          <select
            value={sort}
            onChange={(e) => onSort(e.target.value as SortKey)}
            aria-label={`Sort ${col.title}`}
            className={`hidden rounded-full border border-white/[0.08] bg-transparent px-2 py-1 text-xs outline-none 2xl:block ${sort === 'default' ? 'text-muted' : 'text-ink'}`}
          >
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <option key={k} value={k} className="bg-surface">
                {k === 'default' ? 'Sort' : SORT_LABEL[k]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setShowFilters((s) => !s)}
            aria-expanded={showFilters}
            className={`flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition ${
              showFilters || n || sort !== 'default' ? 'border-white/20 bg-white/[0.06] text-ink' : 'border-white/[0.08] text-muted hover:text-ink'
            }`}
          >
            <Funnel size={12} weight={n ? 'fill' : 'regular'} /> Filter{n ? ` ${n}` : ''}
          </button>
        </div>
      </header>
      {showFilters && <FilterBar value={filters} onChange={onFilters} sort={sort} onSort={onSort} />}
      <ul className="min-h-0 flex-1 overflow-y-auto overscroll-contain" onMouseEnter={() => onPause(true)} onMouseLeave={() => onPause(false)}>
        {tokens.map((t) => (
          <Row
            key={t.address}
            t={t}
            col={col.id}
            serverNow={serverNow}
            flashAt={flashed.get(t.address) ?? 0}
            enter={entering.has(t.address)}
            quick={quick}
            quick2={quick2}
          />
        ))}
        {!tokens.length && (
          <li className="grid h-40 place-items-center px-6 text-center text-sm text-muted">{total ? 'Nothing matches these filters.' : 'Waiting for the next one…'}</li>
        )}
      </ul>
    </section>
  );
}

function FilterBar({ value, onChange, sort, onSort }: { value: Filters; onChange: (f: Filters) => void; sort: SortKey; onSort: (k: SortKey) => void }) {
  const toggle = (k: 'hideHighRisk' | 'hideCopycat' | 'hasSocial', label: string) => (
    <label className="flex items-center gap-2 text-xs">
      <input type="checkbox" checked={value[k]} onChange={(e) => onChange({ ...value, [k]: e.target.checked })} className="accent-[var(--color-brand)]" />
      {label}
    </label>
  );
  const num = (k: keyof Filters, label: string, placeholder: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-muted">{label}</span>
      <input
        inputMode="numeric"
        placeholder={placeholder}
        value={(value[k] as number) || ''}
        onChange={(e) => onChange({ ...value, [k]: Number(e.target.value.replace(/[^0-9]/g, '')) || 0 })}
        className="w-full rounded-lg border border-white/[0.06] bg-bg px-2 py-1.5 font-mono text-xs outline-none focus:border-white/20"
      />
    </label>
  );
  return (
    <div className="grid max-h-[55%] grid-cols-2 gap-2 overflow-y-auto border-b border-white/[0.05] bg-surface-2/50 p-3 lg:grid-cols-4">
      {num('minMcap', 'Min MC $', '0')}
      {num('maxMcap', 'Max MC $', 'any')}
      {num('minVolume', 'Min 24h vol $', '0')}
      {num('minHolders', 'Min holders', '0')}
      {num('maxAgeMin', 'Max age (min)', 'any')}
      {num('maxTop10', 'Max top 10 %', 'any')}
      {num('maxDev', 'Max dev %', 'any')}
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-muted">Sort</span>
        <select value={sort} onChange={(e) => onSort(e.target.value as SortKey)} className="rounded-lg border border-white/[0.06] bg-bg px-2 py-1.5 text-xs outline-none">
          {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
            <option key={k} value={k}>
              {SORT_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-wider text-muted">Launchpad</span>
        <select
          value={value.launchpad}
          onChange={(e) => onChange({ ...value, launchpad: e.target.value })}
          className="rounded-lg border border-white/[0.06] bg-bg px-2 py-1.5 text-xs outline-none"
        >
          <option value="">All</option>
          {['pons', 'doppler', 'lift.fun', 'uniswap-v4'].map((l) => (
            <option key={l} value={l}>
              {LAUNCHPAD_LABEL[l] ?? l}
            </option>
          ))}
        </select>
      </label>
      <div className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 lg:col-span-4">
        {toggle('hideHighRisk', 'Hide high risk')}
        {toggle('hideCopycat', 'Hide copycats')}
        {toggle('hasSocial', 'Has socials')}
      </div>
      <button type="button" onClick={() => onChange(NO_FILTERS)} className="col-span-2 text-left text-[11px] text-muted hover:text-ink lg:col-span-4">
        Reset filters
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ row */

/** Ticks on its own clock so a row doesn't re-render every second. Green for the first minute. */
function Age({ created, serverNow }: { created: number; serverNow: number }) {
  const now = useNow(serverNow);
  return <span className={`shrink-0 font-mono text-[11px] ${now - created < 3_600_000 ? 'text-brand' : 'text-muted'}`}>{age(created, now)}</span>;
}

/** New arrivals grow into place instead of shoving the column down in one frame. */
function slideIn(el: HTMLLIElement | null) {
  if (!el || typeof el.animate !== 'function' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const h = el.offsetHeight;
  el.animate(
    [
      { maxHeight: '0px', opacity: 0, transform: 'translateY(-6px)' },
      { maxHeight: `${h}px`, opacity: 1, transform: 'none' },
    ],
    { duration: 260, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
  );
}

/** Market cap to show: live, else the launch market cap (never "–" when the API knows one). */
const mcapOf = (t: TokenCard) => t.market_cap_usd ?? t.initial_market_cap_usd ?? null;
const taxOf = (t: TokenCard) => {
  if (t.tax_pct != null) return t.tax_pct;
  if (t.buy_tax_bps != null || t.sell_tax_bps != null) return Math.max(t.buy_tax_bps ?? 0, t.sell_tax_bps ?? 0) / 100;
  if (t.buy_tax_pct != null || t.sell_tax_pct != null) return Math.max(t.buy_tax_pct ?? 0, t.sell_tax_pct ?? 0);
  return null;
};

/** One small stat ("Top 10 12%"): muted, red only once it usually means trouble. */
function Stat({ label, value, bad, digits = 0, title }: { label: string; value: number | null; bad: number; digits?: number; title: string }) {
  const hot = value != null && value >= bad;
  return (
    <span title={title} className={hot ? 'text-risk-high' : ''}>
      {label} <span className={`font-mono ${hot ? '' : value != null && value > 0 ? 'text-ink/75' : ''}`}>{value == null ? '–' : pct(value, digits)}</span>
    </span>
  );
}

const Dot = () => <span className="text-muted/40">·</span>;

const Row = memo(function Row({
  t,
  col,
  serverNow,
  flashAt,
  enter,
  quick,
  quick2,
}: {
  t: TokenCard;
  col: Column;
  serverNow: number;
  flashAt: number;
  enter: boolean;
  quick: string;
  quick2: string;
}) {
  const created = ts(t.created_at);
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (enter) slideIn(ref.current);
  }, []); // mount only
  const mcap = mcapOf(t);
  // Market cap colour follows its last move (white until it moves).
  const prev = useRef(mcap);
  const [dir, setDir] = useState<-1 | 0 | 1>(0);
  useEffect(() => {
    if (mcap != null && prev.current != null && mcap !== prev.current) setDir(mcap > prev.current ? 1 : -1);
    prev.current = mcap;
  }, [mcap]);
  const tax = taxOf(t);
  // Known quotes by symbol; ETH is the default and an unknown quote address stays hidden.
  const quoteText = t.quote_symbol ?? quoteLabel(t.quote);
  const quote = quoteText.startsWith('0x') || quoteText === 'ETH' || quoteText === 'WETH' ? null : quoteText;
  const buys = t.buys_24h ?? null;
  const sells = t.sells_24h ?? null;
  const split = buys != null || sells != null;
  const txns = split ? (buys ?? 0) + (sells ?? 0) : (t.trades_24h ?? null);
  const tradeToken = { address: t.address as `0x${string}`, symbol: t.symbol, decimals: 18, risk: t.risk, verdict: t.verdict, createdAt: t.created_at };
  const flags = [
    t.risk === 'high' && 'High risk',
    t.copycat && 'Copycat',
    t.serial_launcher && 'Serial dev',
    !!t.airdropped && t.airdropped > 10 && `${t.airdropped} fake holders`,
  ].filter(Boolean) as string[];
  return (
    <li ref={ref} className="relative overflow-hidden border-b border-white/[0.05] transition-colors hover:border-white/[0.1]">
      {/* Keyed by the update time, so the flash replays on each change and fades out on its own. */}
      {flashAt > 0 && <span key={flashAt} className="row-flash pointer-events-none absolute inset-0" />}
      <div className="group relative flex items-center gap-2.5 px-3 py-3 transition-colors hover:bg-white/[0.03] sm:gap-3 sm:px-4 md:px-5">
        {/* Whole-row link sits underneath; links and buttons above it stay clickable. */}
        <Link href={`/token/${t.address}`} aria-label={`${t.symbol} token page`} className="absolute inset-0" />
        <span className="sm:hidden">
          <RingedAvatar t={t} size={44} ring={ringOf(t, col === 'migrated')} badge />
        </span>
        <span className="hidden sm:block">
          <RingedAvatar t={t} size={52} ring={ringOf(t, col === 'migrated')} badge />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="max-w-[60%] shrink-0 truncate text-base font-semibold leading-tight">{t.symbol}</span>
            {/* Phones clip the flags line, so a red dot keeps the warning visible. */}
            {flags.length > 0 && <span className="size-1.5 shrink-0 self-center rounded-full bg-risk-high sm:hidden" title={flags.join(' · ')} />}
            <span className="min-w-0 truncate text-[13px] text-muted">{t.name}</span>
            <SocialLinks t={t} size={12} className="relative z-10 hidden shrink-0 self-center sm:flex" />
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted">
            <Age created={created} serverNow={serverNow} />
            <Dot />
            <span>
              <span className="font-mono text-ink/75">{t.holders < 1000 ? t.holders : compact(t.holders)}</span> holders
            </span>
            {txns != null && (
              <>
                <Dot />
                <span title={split ? `${buys ?? 0} buys / ${sells ?? 0} sells, 24h` : 'Trades, 24h'}>
                  <span className="font-mono text-ink/75">{txns < 1000 ? txns : compact(txns)}</span> txs
                </span>
              </>
            )}
            {quote && (
              <>
                <Dot />
                <span title="Quote asset">{quote}</span>
              </>
            )}
            {flags.length > 0 && (
              <>
                <Dot />
                <span className="min-w-0 truncate font-medium text-risk-high" title={flags.join(' · ')}>
                  {flags.join(' · ')}
                </span>
              </>
            )}
            {!flags.length && t.risk === 'medium' && (
              <>
                <Dot />
                <span className="font-medium text-risk-medium">Medium risk</span>
              </>
            )}
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-x-2.5 overflow-hidden whitespace-nowrap text-[11px] text-muted">
            <Stat label="Top 10" value={t.top10_pct} bad={30} title="Share held by the top 10 holders" />
            <Stat label="Dev" value={t.dev_pct} bad={10} title="Share the deployer holds" />
            <Stat label="Snipers" value={t.snipers_pct} bad={20} title="Bought by snipers in the first blocks" />
            {tax != null && tax > 0 && <Stat label="Tax" value={tax} bad={10} digits={1} title="Transfer tax" />}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div
            className={`font-mono text-[15px] font-semibold leading-tight ${dir > 0 ? 'text-go' : dir < 0 ? 'text-risk-high' : t.market_cap_usd == null && mcap != null ? 'text-ink/70' : ''}`}
            title={t.market_cap_usd == null && mcap != null ? 'Market cap at launch' : 'Market cap'}
          >
            {usd(mcap)}
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted" title="Volume, 24h">
            vol {usd(t.volume_24h_usd)}
          </div>
        </div>
        <div className="relative z-10 flex shrink-0 items-center gap-1">
          {tradingAvailable() ? (
            <>
              {/* The second amount appears on hover so the list stays calm. */}
              <span className="hidden md:group-hover:inline-flex">
                <QuickBuyButton token={tradeToken} amountEth={quick2} variant="subtle" />
              </span>
              <QuickBuyButton token={tradeToken} amountEth={quick} variant="subtle" />
            </>
          ) : (
            <button
              type="button"
              disabled
              title={`Quick buy ${quick || '0'} ETH of $${t.symbol}. Trading opens soon.`}
              className="flex cursor-not-allowed items-center gap-1 rounded-full bg-brand/15 px-3 py-1.5 font-mono text-xs font-semibold text-brand opacity-80"
            >
              <Lightning size={11} weight="fill" /> {quick || '0'}
            </button>
          )}
        </div>
      </div>
    </li>
  );
});

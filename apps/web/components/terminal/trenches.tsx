'use client';

import Link from 'next/link';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChefHat,
  Crosshair,
  Crown,
  Funnel,
  Lightning,
  Package,
  PauseCircle,
  Plant,
  RocketLaunch,
  Sparkle,
  Users,
} from '@phosphor-icons/react';
import type { Column, TokenCard } from '@/lib/api';
import { age, LAUNCHPAD_LABEL, pct, usd } from '@/lib/format';
import { useTopic, useTopicDeltas } from '@/lib/feed/react';
import { trenchesColumnSpec, trenchesSpec, type TrenchesState } from '@/lib/feed/topics';
import type { Delta } from '@/lib/feed/protocol';
import { useNow } from '@/lib/now';
import { updateSettings, useSettings } from '@/lib/settings';
import { RiskTag, SocialLinks, TokenAvatar } from './bits';

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
  // One-tap buy amount: shared with the settings page.
  const quick = useSettings().quickBuy;

  useEffect(() => setFilters(loadFilters()), []);
  const changeQuick = useCallback((v: string) => updateSettings({ quickBuy: v }), []);
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
          if (keep(t)) out[c].push(t);
        }
      // The column topics carry launchpad tokens only; plain pools still come from the HTTP list.
      if (showPlain) for (const t of tokens.values()) if (!seen.has(t.address) && (t.launchpad ?? 'uniswap-v4') === 'uniswap-v4' && keep(t)) out[columnOf(t)].push(t);
    } else {
      for (const t of tokens.values()) if (keep(t)) out[columnOf(t)].push(t);
    }
    for (const c of COLUMNS) out[c.id].sort(SORT[c.id]);
    return out;
  }, [tokens, serverColumns, colNew.data, colAlmost.data, colMigrated.data, showSpam, showPlain]);
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
      <Toolbar showSpam={showSpam} onShowSpam={setShowSpam} showPlain={showPlain} onShowPlain={setShowPlain} quick={quick} onQuick={changeQuick} />
      {/* Mobile: one column at a time */}
      <div className="flex gap-1 px-2 pb-2 md:hidden">
        {COLUMNS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setMobileCol(c.id)}
            className={`flex-1 rounded-lg py-2 text-xs font-semibold ${mobileCol === c.id ? 'bg-white/[0.08] text-ink' : 'text-muted'}`}
          >
            {c.title}
          </button>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 px-2 pb-2 md:grid-cols-3">
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
  quick,
  onQuick,
}: {
  showSpam: boolean;
  onShowSpam: (v: boolean) => void;
  showPlain: boolean;
  onShowPlain: (v: boolean) => void;
  quick: string;
  onQuick: (v: string) => void;
}) {
  // Local text so partial input ("0.") can be typed; valid amounts are saved as they're entered.
  const [quickText, setQuickText] = useState(quick);
  useEffect(() => setQuickText(quick), [quick]);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
      <h1 className="text-lg font-semibold tracking-[-0.03em]">Trenches</h1>
      <span className="rounded-md bg-white/[0.06] px-2 py-0.5 text-xs text-muted">Robinhood Chain</span>
      <label
        className="ml-2 flex cursor-pointer items-center gap-1.5 text-xs text-muted hover:text-ink"
        title="Airdrop-farm clones: plain pools whose holder count was padded with mass airdrops"
      >
        <input type="checkbox" checked={showSpam} onChange={(e) => onShowSpam(e.target.checked)} className="accent-[var(--color-brand)]" />
        Show spam clones
      </label>
      <label
        className="flex cursor-pointer items-center gap-1.5 text-xs text-muted hover:text-ink"
        title="Tokens launched straight into a Uniswap pool, without a launchpad. Most copycat clones live here."
      >
        <input type="checkbox" checked={showPlain} onChange={(e) => onShowPlain(e.target.checked)} className="accent-[var(--color-brand)]" />
        Plain pools
      </label>
      <div
        className="ml-auto flex items-center gap-1.5 rounded-xl border border-white/[0.06] bg-surface py-1 pl-3 pr-1 text-xs"
        title="Sets the amount on every Buy button. Trading opens soon."
      >
        <Lightning size={14} weight="fill" className="text-brand" />
        <span className="hidden text-muted sm:inline">Quick buy</span>
        <input
          value={quickText}
          onChange={(e) => {
            const v = e.target.value.replace(/[^0-9.]/g, '').slice(0, 8);
            setQuickText(v);
            if (/^\d*\.?\d+$/.test(v) && Number(v) > 0) onQuick(v);
          }}
          onBlur={() => setQuickText(quick)}
          className="w-12 bg-transparent text-right font-mono text-sm text-ink outline-none"
          inputMode="decimal"
          aria-label="Quick buy amount in ETH"
        />
        <span className="font-mono text-muted">ETH</span>
        <span className="ml-1 hidden gap-0.5 sm:flex">
          {['0.05', '0.1', '0.5', '1'].map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onQuick(v)}
              className={`rounded-lg px-1.5 py-1 font-mono text-[11px] ${quick === v ? 'bg-white/[0.1] text-ink' : 'text-muted hover:text-ink'}`}
            >
              {v}
            </button>
          ))}
        </span>
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
  filters: Filters;
  onFilters: (f: Filters) => void;
  onPause: (on: boolean) => void;
  className: string;
}) {
  const [showFilters, setShowFilters] = useState(false);
  const Icon = col.icon;
  const n = activeCount(filters);
  return (
    <section className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-surface ${className}`}>
      <header className="flex items-center gap-2 border-b border-white/[0.05] px-4 py-3">
        <Icon size={16} weight="fill" className="text-brand" />
        <h2 className="text-sm font-semibold">{col.title}</h2>
        <span className="font-mono text-xs text-muted">{total}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {paused ? (
            <span className="flex items-center gap-1 rounded-md bg-risk-medium/15 px-2 py-0.5 text-[11px] font-medium text-risk-medium">
              <PauseCircle size={12} weight="fill" /> Paused{waiting ? ` · ${waiting} new` : ''}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-[11px] text-muted">
              <span className="size-1.5 animate-pulse rounded-full bg-brand" /> Live
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowFilters((s) => !s)}
            className={`flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] transition ${
              showFilters || n ? 'bg-white/[0.08] text-ink' : 'text-muted hover:text-ink'
            }`}
          >
            <Funnel size={12} weight={n ? 'fill' : 'regular'} /> Filter{n ? ` (${n})` : ''}
          </button>
        </div>
      </header>
      {showFilters && <FilterBar value={filters} onChange={onFilters} />}
      <ul
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]"
        onMouseEnter={() => onPause(true)}
        onMouseLeave={() => onPause(false)}
      >
        {tokens.map((t) => (
          <Row
            key={t.address}
            t={t}
            col={col.id}
            serverNow={serverNow}
            flashAt={flashed.get(t.address) ?? 0}
            enter={entering.has(t.address)}
            quick={quick}
          />
        ))}
        {!tokens.length && (
          <li className="grid h-40 place-items-center px-6 text-center text-sm text-muted">
            {total ? 'Nothing matches these filters.' : 'Waiting for the next one…'}
          </li>
        )}
      </ul>
    </section>
  );
}

function FilterBar({ value, onChange }: { value: Filters; onChange: (f: Filters) => void }) {
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
      <label className="col-span-2 flex flex-col gap-1 lg:col-span-4">
        <span className="text-[10px] uppercase tracking-wider text-muted">Keyword</span>
        <input
          placeholder="Symbol, name or 0x…"
          value={value.keyword}
          onChange={(e) => onChange({ ...value, keyword: e.target.value.slice(0, 42) })}
          className="w-full rounded-lg border border-white/[0.06] bg-bg px-2 py-1.5 text-xs outline-none focus:border-white/20"
        />
      </label>
      {num('minMcap', 'Min MC $', '0')}
      {num('maxMcap', 'Max MC $', 'any')}
      {num('minVolume', 'Min 24h vol $', '0')}
      {num('minHolders', 'Min holders', '0')}
      {num('maxAgeMin', 'Max age (min)', 'any')}
      {num('maxTop10', 'Max top 10 %', 'any')}
      {num('maxDev', 'Max dev %', 'any')}
      <label className="col-span-2 flex flex-col gap-1">
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

/** Signal chip: turns red past the point where it usually means trouble. */
function Metric({ icon: Icon, value, bad, title }: { icon: typeof Users; value: number | null; bad: number; title: string }) {
  const hot = value != null && value >= bad;
  return (
    <span title={title} className={`flex items-center gap-0.5 ${hot ? 'text-risk-high' : value != null && value > 0 ? 'text-ink/80' : 'text-muted'}`}>
      <Icon size={12} weight="bold" />
      {pct(value, 0)}
    </span>
  );
}

/** Ticks on its own clock so a row doesn't re-render every second. Green for the first minute. */
function Age({ created, serverNow }: { created: number; serverNow: number }) {
  const now = useNow(serverNow);
  return <span className={`ml-auto shrink-0 font-mono text-xs ${now - created < 60_000 ? 'text-brand' : 'text-muted'}`}>{age(created, now)}</span>;
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

const Row = memo(function Row({
  t,
  col,
  serverNow,
  flashAt,
  enter,
  quick,
}: {
  t: TokenCard;
  col: Column;
  serverNow: number;
  flashAt: number;
  enter: boolean;
  quick: string;
}) {
  const created = ts(t.created_at);
  const bp = t.bonding_progress;
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (enter) slideIn(ref.current);
  }, []); // mount only
  return (
    <li ref={ref} className="relative overflow-hidden border-b border-white/[0.04]">
      {/* Keyed by the update time, so the flash replays on each change and fades out on its own. */}
      {flashAt > 0 && <span key={flashAt} className="row-flash pointer-events-none absolute inset-0" />}
      <div className="group relative flex gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]">
        {/* Whole-row link sits underneath; social icons sit above it so they stay clickable. */}
        <Link href={`/token/${t.address}`} aria-label={`${t.symbol} token page`} className="absolute inset-0" />
        <TokenAvatar t={t} size={44} badge />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[15px] font-semibold">{t.symbol}</span>
            <span className="truncate text-xs text-muted">{t.name}</span>
            <SocialLinks t={t} size={12} className="relative z-10 shrink-0" />
            <Age created={created} serverNow={serverNow} />
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px]">
            <span className="flex items-center gap-0.5 text-ink/80" title="Holders">
              <Users size={12} weight="bold" />
              {t.holders}
            </span>
            <Metric icon={Crown} value={t.top10_pct} bad={30} title="Top 10 holders" />
            <Metric icon={ChefHat} value={t.dev_pct} bad={10} title="Dev holds" />
            <Metric icon={Crosshair} value={t.snipers_pct} bad={20} title="Snipers bought" />
            <Metric icon={Package} value={t.bundled_pct} bad={20} title="Launch bundle" />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <RiskTag risk={t.risk} />
            {t.copycat && <span className="rounded-md bg-risk-high/15 px-1.5 py-0.5 text-[10px] font-semibold text-risk-high">copycat</span>}
            {t.serial_launcher && <span className="rounded-md bg-risk-high/15 px-1.5 py-0.5 text-[10px] font-semibold text-risk-high">serial dev</span>}
            {!!t.airdropped && t.airdropped > 10 && (
              <span className="rounded-md bg-risk-high/15 px-1.5 py-0.5 text-[10px] font-semibold text-risk-high">{t.airdropped} fake holders</span>
            )}
            {col !== 'migrated' && bp != null && (
              <span className="flex flex-1 items-center gap-1.5" title="Bonding curve progress">
                <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/[0.06]">
                  <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.min(100, bp * 100)}%` }} />
                </span>
                <span className="font-mono text-[10px] text-muted">{Math.round(bp * 100)}%</span>
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end justify-between">
          <div className="text-right">
            <div className="font-mono text-[15px] font-semibold">{usd(t.market_cap_usd)}</div>
            <div className="font-mono text-[11px] text-muted">V {usd(t.volume_24h_usd)}</div>
          </div>
          <button
            type="button"
            disabled
            title={`Quick buy ${quick || '0'} ETH of $${t.symbol}. Trading opens soon.`}
            className="relative z-10 flex cursor-not-allowed items-center gap-1 rounded-lg bg-brand/15 px-2.5 py-1 font-mono text-[11px] font-semibold text-brand opacity-75"
          >
            <Lightning size={11} weight="fill" /> {quick || '0'}
          </button>
        </div>
      </div>
    </li>
  );
});

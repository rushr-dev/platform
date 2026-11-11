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
import { useLive, type LiveEvent } from '@/lib/live';
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
  minHolders: number;
  maxAgeMin: number;
  hideHighRisk: boolean;
  launchpad: string;
}
const NO_FILTERS: Filters = { minMcap: 0, maxMcap: 0, minHolders: 0, maxAgeMin: 0, hideHighRisk: false, launchpad: '' };
const activeCount = (f: Filters) =>
  [f.minMcap, f.maxMcap, f.minHolders, f.maxAgeMin, f.hideHighRisk, f.launchpad].filter(Boolean).length;

function passes(t: TokenCard, f: Filters, now: number) {
  const mc = t.market_cap_usd ?? 0;
  if (f.minMcap && mc < f.minMcap) return false;
  if (f.maxMcap && mc > f.maxMcap) return false;
  if (f.minHolders && t.holders < f.minHolders) return false;
  if (f.maxAgeMin && now - ts(t.created_at) > f.maxAgeMin * 60_000) return false;
  if (f.hideHighRisk && t.risk === 'high') return false;
  if (f.launchpad && t.launchpad !== f.launchpad) return false;
  return true;
}

function loadFilters(): Record<Column, Filters> {
  const base = { new: NO_FILTERS, almost: NO_FILTERS, migrated: NO_FILTERS };
  try {
    const raw = localStorage.getItem('rushr.trenches.filters');
    return raw ? { ...base, ...JSON.parse(raw) } : base;
  } catch {
    return base;
  }
}

/* ------------------------------------------------------------------ main */

export function Trenches({ initial, serverNow }: { initial: TokenCard[]; serverNow: number }) {
  // All known tokens by address. Mutated in place; `version` re-renders once per animation frame.
  const tokens = useRef(new Map(initial.map((t) => [t.address, t])));
  const flashed = useRef(new Map<string, number>());
  const pending = useRef<LiveEvent[]>([]);
  const frame = useRef<number | null>(null);
  const [version, setVersion] = useState(0);
  // Start from the server's clock so the first client render matches the HTML (ages are time-based).
  const [now, setNow] = useState(serverNow);
  const [filters, setFilters] = useState<Record<Column, Filters>>({ new: NO_FILTERS, almost: NO_FILTERS, migrated: NO_FILTERS });
  const [paused, setPaused] = useState<Partial<Record<Column, string[]>>>({});
  const [mobileCol, setMobileCol] = useState<Column>('new');
  const [showSpam, setShowSpam] = useState(false);
  const [showPlain, setShowPlain] = useState(false);

  useEffect(() => setFilters(loadFilters()), []);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Batch socket events and apply them once per frame, so a burst of trades costs one render.
  useLive('trenches', (e) => {
    pending.current.push(e);
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null;
      const batch = pending.current;
      pending.current = [];
      const at = Date.now();
      for (const ev of batch) {
        const t = ev.data as TokenCard;
        if (!t?.address) continue;
        const prev = tokens.current.get(t.address);
        tokens.current.set(t.address, { ...prev, ...t });
        if (ev.type === 'launch' || prev?.market_cap_usd !== t.market_cap_usd) flashed.current.set(t.address, at);
      }
      // Keep memory bounded: drop the oldest tokens beyond a generous cap.
      if (tokens.current.size > 1500) {
        const keep = [...tokens.current.values()].sort(SORT.new).slice(0, 1000);
        tokens.current = new Map(keep.map((t) => [t.address, t]));
      }
      setVersion((v) => v + 1);
    });
  });

  const lists = useMemo(() => {
    const out: Record<Column, TokenCard[]> = { new: [], almost: [], migrated: [] };
    for (const t of tokens.current.values()) {
      if (!showSpam && t.spam) continue;
      if (!showPlain && (t.launchpad ?? 'uniswap-v4') === 'uniswap-v4') continue;
      out[columnOf(t)].push(t);
    }
    for (const c of COLUMNS) out[c.id].sort(SORT[c.id]);
    return out;
  }, [version, showSpam, showPlain]);

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
            ? frozen.map((a) => tokens.current.get(a)).filter((t): t is TokenCard => !!t)
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
              now={now}
              flashed={flashed.current}
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
  const [amount, setAmount] = useState('0.1');
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
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
        className="ml-auto flex items-center gap-2 rounded-xl border border-white/[0.06] bg-surface px-3 py-1.5 text-xs"
        title="Quick buy opens with trading, soon"
      >
        <span className="text-muted">Quick buy</span>
        <Lightning size={14} weight="fill" className="text-brand" />
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          className="w-12 bg-transparent text-right font-mono text-sm text-ink outline-none"
          inputMode="decimal"
          aria-label="Quick buy amount in ETH"
        />
        <span className="font-mono text-muted">ETH</span>
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
  now,
  flashed,
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
  now: number;
  flashed: Map<string, number>;
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
          <Row key={t.address} t={t} col={col.id} now={now} flashAt={flashed.get(t.address) ?? 0} />
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
    <div className="grid grid-cols-2 gap-2 border-b border-white/[0.05] bg-surface-2/50 p-3 lg:grid-cols-4">
      {num('minMcap', 'Min MC $', '0')}
      {num('maxMcap', 'Max MC $', 'any')}
      {num('minHolders', 'Min holders', '0')}
      {num('maxAgeMin', 'Max age (min)', 'any')}
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
      <label className="col-span-2 flex items-center gap-2 self-end pb-1.5 text-xs">
        <input
          type="checkbox"
          checked={value.hideHighRisk}
          onChange={(e) => onChange({ ...value, hideHighRisk: e.target.checked })}
          className="accent-[var(--color-brand)]"
        />
        Hide high risk
      </label>
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

const Row = memo(function Row({ t, col, now, flashAt }: { t: TokenCard; col: Column; now: number; flashAt: number }) {
  const created = ts(t.created_at);
  const fresh = now - created < 60_000;
  const flashing = now - flashAt < 1200;
  const bp = t.bonding_progress;
  return (
    <li className="relative border-b border-white/[0.04]">
      {/* Remounts on each update so the flash replays. */}
      {flashing && <span key={flashAt} className="row-flash pointer-events-none absolute inset-0" />}
      <div className="group relative flex gap-3 px-4 py-3 transition-colors hover:bg-white/[0.03]">
        {/* Whole-row link sits underneath; social icons sit above it so they stay clickable. */}
        <Link href={`/token/${t.address}`} aria-label={`${t.symbol} token page`} className="absolute inset-0" />
        <TokenAvatar t={t} size={44} badge />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate text-[15px] font-semibold">{t.symbol}</span>
            <span className="truncate text-xs text-muted">{t.name}</span>
            <SocialLinks t={t} size={12} className="relative z-10 shrink-0" />
            <span className={`ml-auto shrink-0 font-mono text-xs ${fresh ? 'text-brand' : 'text-muted'}`}>{age(created, now)}</span>
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
          <span
            title="Trading opens soon"
            className="flex cursor-not-allowed items-center gap-1 rounded-lg bg-brand/15 px-2.5 py-1 text-[11px] font-semibold text-brand opacity-70"
          >
            <Lightning size={11} weight="fill" /> Buy
          </span>
        </div>
      </div>
    </li>
  );
});

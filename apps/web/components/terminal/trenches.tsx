'use client';

import { RushBanner } from './rush-banner';
import Link from 'next/link';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChefHat,
  Crosshair,
  Fire,
  Megaphone,
  Star,
  Crown,
  Detective,
  Funnel,
  Lightning,
  MagnifyingGlass,
  PauseCircle,
  Plant,
  RocketLaunch,
  Package,
  Sparkle,
  X,
} from '@phosphor-icons/react';
import { API_URL, type Column, type TokenCard } from '@/lib/api';
import { age, compact, LAUNCHPAD_LABEL, LAUNCHPAD_LOGO, pct, quoteLabel, short, usd } from '@/lib/format';
import { useTopic, useTopicDeltas } from '@/lib/feed/react';
import { trenchesColumnSpec, trenchesSpec, type TrenchesState } from '@/lib/feed/topics';
import type { Delta } from '@/lib/feed/protocol';
import { useNow } from '@/lib/now';
import dynamic from 'next/dynamic';
import { tradingAvailable } from '@/components/trade/flag';

import { migrateQuickBuyToUsd, QUICK_USD_PRESETS, updateSettings, useSettings } from '@/lib/settings';
import { useEthUsd } from '@/lib/profile';
import { RingedAvatar, ringOf, SocialLinks } from './bits';
import { CallCard } from './calls-feed';
import { useFeed } from '@/lib/callouts';
import { useWatchlist } from '@/lib/watchlist';
import { SHOW_RISK, SHOW_SERIAL_DEV } from '@/lib/risk-labels';

/** Loaded only when trading is on (one chunk shared by every row). */
const QuickBuyButton = dynamic(() => import('@/components/trade/quick-buy-button').then((m) => m.QuickBuyButton), {
  ssr: false,
  loading: () => <span className="inline-block h-6 w-16 animate-pulse rounded-lg bg-brand/10" />,
});

/* ------------------------------------------------------------------ column rules (mirror the API) */

/** Launchpads whose tokens trade on a bonding curve before graduating (mirrors the API). */
const CURVE_LAUNCHPADS = new Set(['pons', 'liftfun', 'qhooks']);
// Same threshold as the API (apps/indexer/src/data.ts), so a card never jumps columns on a live update.
const ALMOST_BONDED = 0.2;

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

/**
 * The left column is tabs (the middle and right stay Almost bonded and Migrated): Calls first, since calls
 * are what Rushr adds over a plain terminal, then Trending (last hour's volume), the reader's Watchlist, and
 * New pairs for snipers. The last tab used is remembered.
 */
type LeftTab = 'calls' | 'trending' | 'watchlist' | 'new';
const LEFT_TABS: { id: LeftTab; title: string; icon: typeof Plant }[] = [
  { id: 'calls', title: 'Calls', icon: Megaphone },
  { id: 'trending', title: 'Trending', icon: Fire },
  { id: 'watchlist', title: 'Watchlist', icon: Star },
  { id: 'new', title: 'New', icon: Sparkle },
];
const LEFT_KEY = 'rushr.trenches.left';
/** Phone tabs: one scrollable row with the left column's tabs, then the other two columns. */
type MobileTab = LeftTab | 'almost' | 'migrated';
const MOBILE_TABS: { id: MobileTab; title: string }[] = [
  ...LEFT_TABS.map((t) => ({ id: t.id as MobileTab, title: t.title })),
  { id: 'almost', title: 'Almost' },
  { id: 'migrated', title: 'Migrated' },
];
/** A token card with Trending's numbers (GET /tokens/trending). */
type TrendCard = TokenCard & { trend?: { volume1h: number; trades1h: number; calls1h: number; featured: boolean } };

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
  /** Only these launchpads (none checked: all). */
  launchpads: string[];
  keyword: string;
}
/** Launchpads offered as filter checkboxes, in this order. */
const FILTER_LAUNCHPADS = ['uniswap-v4', 'pons', 'qhooks'] as const;
const NO_FILTERS: Filters = {
  minMcap: 0, maxMcap: 0, minVolume: 0, minHolders: 0, maxAgeMin: 0, maxTop10: 0, maxDev: 0,
  hideHighRisk: false, hideCopycat: false, hasSocial: false, launchpads: [], keyword: '',
};
const activeCount = (f: Filters) =>
  (Object.keys(NO_FILTERS) as (keyof Filters)[]).filter((k) => (k === 'launchpads' ? f.launchpads.length > 0 : f[k] !== NO_FILTERS[k])).length;

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
  if (SHOW_RISK && f.hideHighRisk && t.risk === 'high') return false;
  if (SHOW_RISK && f.hideCopycat && t.copycat) return false;
  if (f.hasSocial && !t.website && !t.twitter && !t.telegram) return false;
  if (f.launchpads.length && !f.launchpads.includes(t.launchpad ?? 'uniswap-v4')) return false;
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
    // Older saves lack the newer keys (and kept one `launchpad` string): fill them in.
    const fix = (f: (Partial<Filters> & { launchpad?: string }) | undefined): Filters => {
      const { launchpad, ...rest } = f ?? {};
      const pads = Array.isArray(rest.launchpads) ? rest.launchpads : launchpad ? [launchpad] : [];
      return { ...NO_FILTERS, ...rest, launchpads: pads.filter((l) => (FILTER_LAUNCHPADS as readonly string[]).includes(l)) };
    };
    return { new: fix(raw.new), almost: fix(raw.almost), migrated: fix(raw.migrated) };
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
  const [leftTab, setLeftTabState] = useState<LeftTab>('calls');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(LEFT_KEY) as LeftTab | null;
      if (saved && LEFT_TABS.some((t) => t.id === saved)) setLeftTabState(saved);
    } catch {
      // storage unavailable
    }
  }, []);
  const setLeftTab = useCallback((t: LeftTab) => {
    setLeftTabState(t);
    try {
      localStorage.setItem(LEFT_KEY, t);
    } catch {
      // storage unavailable
    }
  }, []);
  // Phones show one column at a time: the left panel (any of its tabs) or one of the other two.
  const [mobileCol, setMobileCol] = useState<'left' | 'almost' | 'migrated'>('left');
  const mobileActive: MobileTab = mobileCol === 'left' ? leftTab : mobileCol;
  const [showSpam, setShowSpam] = useState(false);
  const [showPlain, setShowPlain] = useState(false);
  // One-tap buy amounts in dollars (P1/P2): shared with the settings page.
  const { quickBuyUsd: quick, quickBuy2Usd: quick2 } = useSettings();
  // Saves from before dollar amounts move to the nearest dollar preset once the ETH price is in.
  const ethUsd = useEthUsd();
  useEffect(() => migrateQuickBuyToUsd(ethUsd), [ethUsd]);
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
  const changeQuick = useCallback((v: number) => updateSettings({ quickBuyUsd: v }), []);
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

  // A column filtered to launchpads lists those launchpads' tokens beyond the live cards: every age for PONS and
  // QHooks (launches can be weeks old), and the plain-pool Uniswap tokens the live view hides by default.
  // Fetched once per launchpad change, then merged with the live cards below.
  const [byLaunchpad, setByLaunchpad] = useState<Partial<Record<Column, TokenCard[]>>>({});
  const padKey = COLUMNS.map((c) => filters[c.id].launchpads.join(',')).join('|');
  useEffect(() => {
    const ctl = new AbortController();
    setByLaunchpad({});
    for (const c of COLUMNS)
      for (const lp of filters[c.id].launchpads) {
        const ageParam = lp === 'uniswap-v4' ? '' : '&maxAgeMin=5256000';
        fetch(`${API_URL}/tokens?column=${c.id}&launchpad=${encodeURIComponent(lp)}${ageParam}&limit=100&plain=1`, { signal: ctl.signal })
          .then((r) => (r.ok ? (r.json() as Promise<{ tokens: (TokenCard | null)[] }>) : null))
          .then((b) => b && setByLaunchpad((p) => ({ ...p, [c.id]: [...(p[c.id] ?? []), ...b.tokens.filter((t): t is TokenCard => t != null)] })))
          .catch(() => undefined);
      }
    return () => ctl.abort();
    // Refetch only when a column's launchpad changes (padKey), not on every filter edit.
  }, [padKey]);

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
    // Older tokens of a filtered launchpad (live cards win: they're fresher).
    for (const c of COLUMNS) {
      const extra = byLaunchpad[c.id];
      if (!extra?.length) continue;
      const have = new Set(out[c.id].map((t) => t.address));
      for (const t of extra) if (!have.has(t.address) && (showSpam || !t.spam)) out[c.id].push(t);
    }
    for (const c of COLUMNS) {
      const k = sorts[c.id];
      out[c.id].sort(k === 'default' ? SORT[c.id] : (a, b) => BY[k](a, b) || SORT[c.id](a, b));
    }
    return out;
  }, [tokens, serverColumns, colNew.data, colAlmost.data, colMigrated.data, showSpam, showPlain, sorts, byLaunchpad]);
  // Paused columns look tokens up by address across every source.
  // The launchpad-filter fetches count too, or a paused (hovered) column would drop their cards.
  const byAddress = useMemo(() => {
    const extra = COLUMNS.flatMap((c) => (byLaunchpad[c.id] ?? []).map((t) => [t.address, t] as const));
    return serverColumns ? new Map([...extra, ...tokens, ...colNew.data, ...colAlmost.data, ...colMigrated.data]) : new Map([...extra, ...tokens]);
  }, [serverColumns, tokens, colNew.data, colAlmost.data, colMigrated.data, byLaunchpad]);

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
      <RushBanner />
      {/* Mobile: one column at a time */}
      <div className="flex gap-1 overflow-x-auto px-2 pb-2 [scrollbar-width:none] md:hidden">
        {MOBILE_TABS.map((m) => (
          <button
            key={m.id}
            type="button"
            onClick={() => {
              if (m.id === 'almost' || m.id === 'migrated') setMobileCol(m.id);
              else {
                setLeftTab(m.id);
                setMobileCol('left');
              }
            }}
            className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold ${mobileActive === m.id ? 'bg-white/[0.08] text-ink' : 'text-muted'}`}
          >
            {m.title}
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
          const tabs = c.id === 'new' ? <LeftTabs value={leftTab} onChange={setLeftTab} /> : null;
          const hidden = c.id === 'new' ? (mobileCol === 'left' ? '' : 'hidden md:flex') : mobileCol === c.id ? '' : 'hidden md:flex';
          if (c.id === 'new' && leftTab !== 'new')
            return (
              <LeftPanel key="left" tab={leftTab} tabs={tabs!} serverNow={serverNow} nowMs={now} quick={quick} quick2={quick2} className={hidden} />
            );
          return (
            <ColumnPanel
              tabs={tabs}
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
              className={hidden}
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
  quick: number;
  onQuick: (v: number) => void;
}) {
  // Local text so partial input ("12.") can be typed; valid amounts are saved as they're entered.
  const [quickText, setQuickText] = useState(String(quick));
  useEffect(() => setQuickText(String(quick)), [quick]);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
      <h1 className="text-lg font-semibold tracking-[-0.03em]">Trenches</h1>
      <span className="rounded-md bg-white/[0.06] px-2 py-0.5 text-xs text-muted">Robinhood Chain</span>
      {/* Hidden with the risk labels: spam clones and plain pools stay filtered out by default. */}
      {SHOW_RISK && (
        <>
      <label
        className="ml-2 flex cursor-pointer items-center gap-1.5 text-xs text-muted hover:text-ink"
        title="Airdrop-farm clones: plain pools whose holder count was padded with mass airdrops"
      >
        <input type="checkbox" checked={showSpam} onChange={(e) => onShowSpam(e.target.checked)} className="accent-[var(--color-brand)]" />
        Show spam clones
      </label>
      <label
        className="flex cursor-pointer items-center gap-1.5 text-xs text-muted hover:text-ink"
        title="Tokens launched straight into a Uniswap pool, without a launchpad."
      >
        <input type="checkbox" checked={showPlain} onChange={(e) => onShowPlain(e.target.checked)} className="accent-[var(--color-brand)]" />
        Plain pools
      </label>
        </>
      )}
      <div
        className="ml-auto flex items-center gap-1.5 rounded-xl border border-white/[0.06] bg-surface py-1 pl-3 pr-1 text-xs"
        title="The first Buy amount on every card, in US dollars (converted to ETH at the live price)"
      >
        <Lightning size={14} weight="fill" className="text-brand" />
        <span className="hidden text-muted sm:inline">Quick buy</span>
        <span className="ml-1 hidden gap-0.5 sm:flex">
          {QUICK_USD_PRESETS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => onQuick(v)}
              className={`rounded-lg px-1.5 py-1 font-mono text-[11px] ${quick === v ? 'bg-white/[0.1] text-ink' : 'text-muted hover:text-ink'}`}
            >
              ${v}
            </button>
          ))}
        </span>
        <label
          className={`flex items-center rounded-lg px-1.5 py-0.5 font-mono ${(QUICK_USD_PRESETS as readonly number[]).includes(quick) ? '' : 'sm:bg-white/[0.1]'}`}
          title="Custom amount"
        >
          <span className="text-muted">$</span>
          <input
            value={quickText}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9.]/g, '').slice(0, 7);
              setQuickText(v);
              if (/^\d*\.?\d+$/.test(v) && Number(v) >= 1) onQuick(Number(v));
            }}
            onBlur={() => setQuickText(String(quick))}
            className="w-11 bg-transparent font-mono text-sm text-ink outline-none"
            inputMode="decimal"
            aria-label="Quick buy amount in US dollars"
          />
        </label>
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
  tabs = null,
}: {
  /** The left column's tab bar, shown above the header (New pairs is one of the left tabs). */
  tabs?: React.ReactNode;
  col: (typeof COLUMNS)[number];
  tokens: TokenCard[];
  total: number;
  waiting: number;
  paused: boolean;
  flashed: Map<string, number>;
  entering: Set<string>;
  serverNow: number;
  quick: number;
  quick2: number;
  sort: SortKey;
  onSort: (k: SortKey) => void;
  filters: Filters;
  onFilters: (f: Filters) => void;
  onPause: (on: boolean) => void;
  className: string;
}) {
  const [showFilters, setShowFilters] = useState(false);
  const Icon = col.icon;
  const n = activeCount(filters);
  return (
    <section className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-surface ${className}`}>
      {tabs}
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
            className={`flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition ${
              showFilters || n ? 'border-white/20 bg-white/[0.06] text-ink' : 'border-white/[0.08] text-muted hover:border-white/15 hover:text-ink'
            }`}
          >
            <Funnel size={12} weight={n ? 'fill' : 'regular'} /> Filter{n ? ` (${n})` : ''}
          </button>
        </div>
      </header>
      <div className="flex items-center gap-1.5 border-b border-white/[0.05] px-3 py-1.5">
        <label className="flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 transition-colors focus-within:border-white/20 hover:border-white/15">
          <MagnifyingGlass size={12} className="shrink-0 text-muted" />
          <input
            value={filters.keyword}
            onChange={(e) => onFilters({ ...filters, keyword: e.target.value.slice(0, 42) })}
            placeholder="Keyword, symbol or 0x…"
            aria-label={`Filter ${col.title} by keyword`}
            className="w-full min-w-0 bg-transparent text-[11px] outline-none placeholder:text-muted/70"
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
          className={`rounded-full border border-white/[0.08] bg-transparent px-2.5 py-1.5 text-[11px] outline-none transition-colors hover:border-white/15 ${sort === 'default' ? 'text-muted' : 'text-ink'}`}
        >
          {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
            <option key={k} value={k}>
              {k === 'default' ? 'Sort' : SORT_LABEL[k]}
            </option>
          ))}
        </select>
      </div>
      {showFilters && <FilterBar value={filters} onChange={onFilters} />}
      <ul
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
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
            quick2={quick2}
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
        className="w-full rounded-lg border border-white/[0.06] bg-black/30 px-2 py-1.5 font-mono text-xs outline-none focus:border-white/20"
      />
    </label>
  );
  return (
    <div className="grid max-h-[55%] grid-cols-2 gap-2 overflow-y-auto border-b border-white/[0.05] bg-white/[0.02] p-3 lg:grid-cols-4">
      {num('minMcap', 'Min MC $', '0')}
      {num('maxMcap', 'Max MC $', 'any')}
      {num('minVolume', 'Min 24h vol $', '0')}
      {num('minHolders', 'Min holders', '0')}
      {num('maxAgeMin', 'Max age (min)', 'any')}
      {num('maxTop10', 'Max top 10 %', 'any')}
      {num('maxDev', 'Max dev %', 'any')}
      <fieldset className="col-span-2 flex flex-col gap-1 lg:col-span-4">
        <legend className="mb-1 text-[10px] uppercase tracking-wider text-muted">Launchpad</legend>
        <div className="flex flex-wrap gap-1.5">
          {FILTER_LAUNCHPADS.map((l) => {
            const on = value.launchpads.includes(l);
            return (
              <label
                key={l}
                className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1 text-xs ${on ? 'border-brand/50 bg-brand/10 text-ink' : 'border-white/[0.08] text-muted hover:text-ink'}`}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => onChange({ ...value, launchpads: e.target.checked ? [...value.launchpads, l] : value.launchpads.filter((x) => x !== l) })}
                  className="accent-[var(--color-brand)]"
                />
                {LAUNCHPAD_LOGO[l] && <img src={LAUNCHPAD_LOGO[l]} alt="" width={14} height={14} className="size-3.5 rounded-full" />}
                {LAUNCHPAD_LABEL[l] ?? l}
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 lg:col-span-4">
        {SHOW_RISK && toggle('hideHighRisk', 'Hide high risk')}
        {SHOW_RISK && toggle('hideCopycat', 'Hide copycats')}
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

/**
 * Bordered stat chip with an icon (GMGN-style): amber from half the "bad" level, red past it, so
 * trouble stands out while healthy values stay quiet.
 */
function Pill({ icon: Icon, value, bad, title, digits = 0 }: { icon: typeof Crown; value: number | null; bad: number; title: string; digits?: number }) {
  const hot = value != null && value >= bad;
  const warm = !hot && value != null && value >= bad / 2;
  return (
    <span
      title={`${title}: ${value == null ? 'unknown' : pct(value, digits)}`}
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-md border px-1.5 py-px ${
        hot
          ? 'border-risk-high/30 text-risk-high'
          : warm
            ? 'border-risk-medium/30 text-risk-medium'
            : value != null && value > 0
              ? 'border-white/[0.07] text-ink/80'
              : 'border-white/[0.05] text-muted'
      }`}
    >
      <Icon size={11} weight="bold" />
      {value == null ? '–' : pct(value, digits)}
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
  note = null,
}: {
  t: TokenCard;
  col: Column;
  serverNow: number;
  flashAt: number;
  enter: boolean;
  quick: number;
  quick2: number;
  /** An extra line under the stats (Trending's hour numbers). */
  note?: React.ReactNode;
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
  const moveTone = dir > 0 ? 'text-go' : dir < 0 ? 'text-risk-high' : '';
  const handle = t.creator_x ?? t.twitter_handle ?? null;
  const tradeToken = { address: t.address as `0x${string}`, symbol: t.symbol, decimals: 18, risk: t.risk, verdict: t.verdict, createdAt: t.created_at };
  const flags = [
    SHOW_RISK && t.risk === 'high' && 'High risk',
    SHOW_RISK && t.copycat && 'Copycat',
    SHOW_SERIAL_DEV && t.serial_launcher && 'Serial dev',
    !!t.airdropped && t.airdropped > 10 && `${t.airdropped} fake holders`,
  ].filter(Boolean) as string[];
  return (
    <li ref={ref} className="relative overflow-hidden border-b border-white/[0.05] transition-colors hover:border-white/[0.1]">
      {/* Keyed by the update time, so the flash replays on each change and fades out on its own. */}
      {flashAt > 0 && <span key={flashAt} className="trench-flash pointer-events-none absolute inset-0" />}
      <div className="group relative px-3 pb-2.5 pt-3 transition-colors hover:bg-white/[0.03] sm:px-4 md:px-5">
        {/* Whole-row link sits underneath; links and buttons above it stay clickable. */}
        <Link href={`/token/${t.address}`} aria-label={`${t.symbol} token page`} className="absolute inset-0" />
        <div className="flex items-center gap-2.5 sm:gap-3">
        <span className="flex shrink-0 flex-col items-center gap-1">
          <span className="sm:hidden">
            <RingedAvatar t={t} size={44} ring={ringOf(t, col === 'migrated')} badge />
          </span>
          <span className="hidden sm:block">
            <RingedAvatar t={t} size={52} ring={ringOf(t, col === 'migrated')} badge />
          </span>
          <span className="font-mono text-[9px] leading-none text-muted">{short(t.address, 2, 4)}</span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="max-w-[60%] shrink-0 truncate text-base font-semibold leading-tight">{t.symbol}</span>
            <span className="min-w-0 truncate text-[13px] text-muted">{t.name}</span>
            <SocialLinks t={t} size={12} className="relative z-10 hidden shrink-0 self-center sm:flex" />
          </div>
          <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-xs text-muted">
            {flags.length > 0 && (
              <>
                <span className="shrink-0 font-medium text-risk-high" title={flags.join(' · ')}>
                  {flags[0]}
                  {flags.length > 1 && ` +${flags.length - 1}`}
                </span>
                <Dot />
              </>
            )}
            {SHOW_RISK && !flags.length && t.risk === 'medium' && (
              <>
                <span className="shrink-0 font-medium text-risk-medium">Medium risk</span>
                <Dot />
              </>
            )}
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
            {handle && (
              <>
                <Dot />
                <a
                  href={`https://x.com/${handle}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={(e) => e.stopPropagation()}
                  className="relative z-10 hover:text-ink"
                  title="Creator on X"
                >
                  @{handle}
                </a>
              </>
            )}
          </div>
          {note && <div className="mt-1 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[11px] text-muted">{note}</div>}
        </div>
        {/* Right-aligned stack: small muted labels right before each value. */}
        <div className="flex shrink-0 flex-col items-end gap-0.5 font-mono">
          <div className="flex items-baseline gap-1" title={t.market_cap_usd == null && mcap != null ? 'Market cap at launch' : 'Market cap'}>
            <span className="text-[10px] text-muted">MC</span>
            <span className={`text-[14px] font-semibold leading-tight ${moveTone || (t.market_cap_usd == null && mcap != null ? 'text-ink/70' : '')}`}>{usd(mcap)}</span>
          </div>
          <div className="flex items-baseline gap-1" title="Volume, 24h">
            <span className="text-[10px] text-muted">V</span>
            <span className={`text-[14px] font-semibold leading-tight ${moveTone}`}>{usd(t.volume_24h_usd)}</span>
          </div>
          {split && (
            <span className="ml-auto mt-1 flex h-[3px] w-14 overflow-hidden rounded-full bg-risk-high/70" title={`${buys ?? 0} buys / ${sells ?? 0} sells, 24h`}>
              <span className="h-full bg-brand" style={{ width: `${txns ? ((buys ?? 0) / txns) * 100 : 50}%` }} />
            </span>
          )}
        </div>
        </div>
        <div className="mt-2 flex items-center gap-1 font-mono text-[10px]">
          <span className="flex min-w-0 items-center gap-1 overflow-hidden">
            <Pill icon={Crown} value={t.top10_pct} bad={30} title="Top 10 holders" />
            <Pill icon={ChefHat} value={t.dev_pct} bad={10} title="Dev holds" />
            <Pill icon={Crosshair} value={t.snipers_pct} bad={20} title="Snipers bought" />
            <Pill icon={Detective} value={t.insiders_pct} bad={20} title="Insiders hold" />
            <Pill icon={Package} value={t.bundled_pct} bad={20} title="Launch bundle" />
            {tax != null && tax > 0 && (
              <span className={`shrink-0 rounded-md px-1.5 py-px font-semibold ${tax >= 10 ? 'bg-risk-high/15 text-risk-high' : 'bg-white/[0.07] text-ink/80'}`} title="Transfer tax">
                Tax {pct(tax, 1)}
              </span>
            )}
          </span>
          <span className="relative z-10 ml-auto flex shrink-0 items-center gap-1">
            {tradingAvailable() ? (
              <>
                <QuickBuyButton token={tradeToken} amountUsd={quick} variant="subtle" />
                <QuickBuyButton token={tradeToken} amountUsd={quick2} variant="subtle" />
              </>
            ) : (
              [quick, quick2].map((q, i) => (
                <button
                  key={i}
                  type="button"
                  disabled
                  title={`Quick buy $${q} of $${t.symbol}. Trading opens soon.`}
                  className="flex cursor-not-allowed items-center gap-0.5 rounded-lg bg-brand/15 px-2 py-1 font-mono text-[11px] font-semibold text-brand opacity-75"
                >
                  <Lightning size={10} weight="fill" /> ${q}
                </button>
              ))
            )}
          </span>
        </div>
      </div>
    </li>
  );
});

/* ------------------------------------------------------------------ left column tabs */

function LeftTabs({ value, onChange }: { value: LeftTab; onChange: (t: LeftTab) => void }) {
  return (
    <div role="tablist" aria-label="Left column" className="hidden gap-1 border-b border-white/[0.05] px-2 pt-2 md:flex">
      {LEFT_TABS.map((t) => {
        const on = value === t.id;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            role="tab"
            aria-selected={on}
            type="button"
            onClick={() => onChange(t.id)}
            className={`flex items-center gap-1.5 rounded-t-lg border-b-2 px-2.5 pb-2 pt-1 text-xs font-semibold transition-colors ${
              on ? 'border-brand text-ink' : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            <Icon size={13} weight={on ? 'fill' : 'regular'} className={on ? 'text-brand' : ''} />
            {t.title}
          </button>
        );
      })}
    </div>
  );
}

/** Calls, Trending or Watchlist in the left column (New pairs uses the regular column panel). */
function LeftPanel({
  tab,
  tabs,
  serverNow,
  nowMs,
  quick,
  quick2,
  className,
}: {
  tab: Exclude<LeftTab, 'new'>;
  tabs: React.ReactNode;
  serverNow: number;
  nowMs: number;
  quick: number;
  quick2: number;
  className: string;
}) {
  return (
    <section className={`flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/[0.07] bg-surface ${className}`}>
      {tabs}
      {tab === 'calls' && <CallsTab nowMs={nowMs} />}
      {tab === 'trending' && <TrendingTab serverNow={serverNow} quick={quick} quick2={quick2} />}
      {tab === 'watchlist' && <WatchlistTab serverNow={serverNow} quick={quick} quick2={quick2} />}
    </section>
  );
}

function TabHeader({ title, sub, right }: { title: string; sub: string; right?: React.ReactNode }) {
  return (
    <header className="flex items-center gap-2 border-b border-white/[0.05] px-4 py-2.5">
      <h2 className="text-sm font-semibold">{title}</h2>
      <span className="text-[11px] text-muted">{sub}</span>
      <div className="ml-auto flex items-center gap-1.5 text-[11px]">{right}</div>
    </header>
  );
}

const LiveDot = () => (
  <span className="flex items-center gap-1.5 text-muted">
    <span className="size-1.5 animate-pulse rounded-full bg-brand" /> Live
  </span>
);

function ListSkeleton() {
  return (
    <ul className="space-y-2 p-3" aria-busy>
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="h-20 animate-pulse rounded-xl bg-white/[0.03]" />
      ))}
    </ul>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <div className="grid flex-1 place-items-center p-8 text-center text-sm text-muted">{children}</div>;
}

/** The latest calls from humans and agents, newest first, with the move since each call. */
function CallsTab({ nowMs }: { nowMs: number }) {
  const feed = useFeed('global');
  return (
    <>
      <TabHeader
        title="Calls"
        sub="humans and AI agents"
        right={
          <>
            <LiveDot />
            <Link href="/feed" className="rounded-full border border-white/[0.08] px-2.5 py-1 text-muted hover:text-ink">
              Open feed
            </Link>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {feed.incoming.length > 0 && (
          <button type="button" onClick={feed.showIncoming} className="sticky top-0 z-10 mx-auto my-2 block rounded-full bg-brand px-3 py-1 text-xs font-semibold text-bg shadow">
            {feed.incoming.length} new call{feed.incoming.length > 1 ? 's' : ''}
          </button>
        )}
        {feed.items == null ? (
          <ListSkeleton />
        ) : feed.items.length === 0 ? (
          <EmptyNote>No calls yet. Call a token from its page.</EmptyNote>
        ) : (
          <ul className="space-y-2 p-2">
            {feed.items.slice(0, 40).map((c) => (
              <CallCard key={c.id} c={c} nowMs={nowMs} showToken />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** Tokens by swap volume over the last hour (GET /tokens/trending, refreshed every 2 minutes server side). */
function TrendingTab({ serverNow, quick, quick2 }: { serverNow: number; quick: number; quick2: number }) {
  const [rows, setRows] = useState<TrendCard[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      fetch(`${API_URL}/tokens/trending`)
        .then((r) => (r.ok ? (r.json() as Promise<{ tokens: TrendCard[] }>) : null))
        .then((b) => live && b && setRows(b.tokens))
        .catch(() => undefined);
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return (
    <>
      <TabHeader title="Trending" sub="by volume, last hour" right={<LiveDot />} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {rows == null ? (
          <ListSkeleton />
        ) : rows.length === 0 ? (
          <EmptyNote>Nothing traded in the last hour yet.</EmptyNote>
        ) : (
          <ul>
            {rows.map((t, i) => (
              <Row
                key={t.address}
                t={t}
                col={t.status === 'migrated' ? 'migrated' : 'new'}
                serverNow={serverNow}
                flashAt={0}
                enter={false}
                quick={quick}
                quick2={quick2}
                note={
                  t.trend && (
                    <>
                      {t.trend.featured ? (
                        <span className="rounded bg-brand/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-brand">Featured</span>
                      ) : (
                        <span className="font-mono text-ink/70">#{i + 1 - rows.filter((r, j) => j < i && r.trend?.featured).length}</span>
                      )}
                      {/* A featured token with no trades this hour shows its label only, not zeros. */}
                      {t.trend.volume1h > 0 && (
                        <>
                          <Dot />
                          <span>
                            <span className="font-mono text-ink/75">{usd(t.trend.volume1h)}</span> vol 1h
                          </span>
                          <Dot />
                          <span>
                            <span className="font-mono text-ink/75">{t.trend.trades1h < 1000 ? t.trend.trades1h : compact(t.trend.trades1h)}</span> trades
                          </span>
                        </>
                      )}
                      {t.trend.calls1h > 0 && (
                        <>
                          <Dot />
                          <span className="flex items-center gap-1 text-brand">
                            <Megaphone size={11} weight="fill" /> {t.trend.calls1h} call{t.trend.calls1h > 1 ? 's' : ''}
                          </span>
                        </>
                      )}
                    </>
                  )
                }
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** The reader's starred tokens (lib/watchlist, this browser), live cards from the API. */
function WatchlistTab({ serverNow, quick, quick2 }: { serverNow: number; quick: number; quick2: number }) {
  const list = useWatchlist();
  const [cards, setCards] = useState<Map<string, TokenCard>>(new Map());
  const key = list.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    const load = async () => {
      const got = await Promise.all(
        key.split(',').map((a) =>
          fetch(`${API_URL}/tokens/${a}`)
            .then((r) => (r.ok ? (r.json() as Promise<TokenCard>) : null))
            .catch(() => null),
        ),
      );
      if (live) setCards(new Map(got.filter((t): t is TokenCard => !!t?.address).map((t) => [t.address, t])));
    };
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [key]);
  const shown = list.map((a) => cards.get(a)).filter((t): t is TokenCard => !!t);
  return (
    <>
      <TabHeader title="Watchlist" sub={list.length ? `${list.length} starred` : 'on this device'} />
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {!list.length ? (
          <EmptyNote>
            Star a token on its page to keep it here.
            <br />
            Your watchlist stays on this device.
          </EmptyNote>
        ) : !shown.length ? (
          <ListSkeleton />
        ) : (
          <ul>
            {shown.map((t) => (
              <Row key={t.address} t={t} col={t.status === 'migrated' ? 'migrated' : 'new'} serverNow={serverNow} flashAt={0} enter={false} quick={quick} quick2={quick2} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

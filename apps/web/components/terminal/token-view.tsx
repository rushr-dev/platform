'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, CheckCircle, Copy, Info, Lightning, Warning, WarningOctagon } from '@phosphor-icons/react';
import { API_URL, type Candle, type SignalReason, type TokenDetail } from '@/lib/api';
import { ageLong, compact, dateTimeUtc, dateUtc, dexscreenerUrl, EXPLORER, quoteLabel, LAUNCHPAD_LABEL, nf, pct, pctSigned, price, short, usd, usdSigned } from '@/lib/format';
import { useTopic } from '@/lib/feed/react';
import { tokenSpec, type ServerStats, type TokenState } from '@/lib/feed/topics';
import { useNow } from '@/lib/now';
import { aggregate, usePairs, type Pair } from '@/lib/pairs';
import { mergePools, useApiPools } from '@/lib/pools';

import { holderContext, toWhole, TRADE_LIMIT, windowStats, WINDOWS, type HolderInfo, type Tx, type WindowId, type WindowStats as WindowStatsT } from '@/lib/trades';
import { RiskTag, SocialLinks, TokenAvatar, riskText } from './bits';
import { hydrationLabel, isHydrating, PriceChart } from './chart';
import dynamic from 'next/dynamic';
import { tradingAvailable } from '@/components/trade/flag';
import { useAuth } from '@/lib/auth';
import { usePosition } from '@/lib/position';
import { updateSettings, useSettings } from '@/lib/settings';
import { AboutCard, PositionCard, ThesisBox } from './simple-rail';
import { useEthUsd } from '@/lib/profile';

import { BubblesTab, DevTokensTab, EarlyBuyersTab, HoldersTab, TopTradersTab, useFetch } from './token-tabs';
import { TradesTable } from './trades-table';

/** Loaded only when trading is on, so the token page doesn't carry the quoting code otherwise. */
const SimpleTrade = dynamic(() => import('./simple-trade').then((m) => m.SimpleTrade), {
  ssr: false,
  loading: () => <div className="h-[330px] shrink-0 animate-pulse rounded-2xl border border-white/[0.06] bg-surface" />,
});
const TradePanel = dynamic(() => import('./trade-panel').then((m) => m.TradePanel), {
  ssr: false,
  loading: () => <div className="h-[380px] shrink-0 animate-pulse rounded-2xl border border-white/[0.06] bg-surface" />,
});

type Pools = ReturnType<typeof mergePools>;

/** A hydrating token's minimal card may not have a creation time yet. */
const known = (iso: string | null | undefined) => !!iso && Number.isFinite(new Date(iso).getTime()) && new Date(iso).getTime() > 0;

/**
 * Token page. The header renders from the server; trades and candles arrive as promises that
 * resolve while the page is already on screen, and holders (slow) load in the background to
 * tag makers. Live trades from the socket are merged into one newest-first list.
 */
export function TokenView({
  detail,
  tradesP,
  candlesP,
  serverNow,
}: {
  detail: TokenDetail;
  tradesP: Promise<Tx[]>;
  candlesP: Promise<Candle[]>;
  serverNow: number;
}) {
  // Header data from the server render, then the feed: snapshot (the streamed trade list today,
  // a socket snapshot on v2) plus live deltas.
  const live = useTopic<TokenState>(`token:${detail.address}`, () => tokenSpec(detail, tradesP));
  const { token: t, trades, fetched, candles: feedCandles } = live.data;
  const [httpCandles, setCandles] = useState<Candle[] | null>(null);
  // v2 carries candles in the feed (and streams history in while hydrating); v1 reads them over HTTP.
  const candles = feedCandles ?? httpCandles;
  const hydrating = isHydrating(live.hydration);
  const [maker, setMaker] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('trades');
  const supply = toWhole(detail.total_supply, detail.decimals) ?? 0;

  useEffect(() => {
    let mounted = true;
    // Streamed RSC promises are bare thenables; wrap them to get a real promise chain.
    Promise.resolve(candlesP)
      .then((c) => mounted && setCandles(c))
      .catch(() => mounted && setCandles([]));
    return () => {
      mounted = false;
    };
  }, [candlesP]);

  const holdersQ = useFetch<{ holders: HolderInfo[]; total: number }>(`${API_URL}/tokens/${detail.address}/holders`);
  const ctx = useMemo(() => holderContext(detail.deployer, holdersQ.data?.holders ?? null), [detail.deployer, holdersQ.data]);
  const pairs = usePairs(detail.address);
  const apiPools = useApiPools(detail.address);
  // v2 snapshots carry pools; until then (and on v1) the HTTP endpoint, then DexScreener.
  const feedPools = live.data.pools;
  const pools = useMemo(() => mergePools(feedPools ?? apiPools, pairs, quoteLabel), [feedPools, apiPools, pairs]);

  const showMaker = useCallback((w: string | null) => {
    setMaker(w);
    if (w) setTab('trades');
  }, []);

  const priceNow = trades?.[0]?.priceUsd ?? t.price_usd ?? null;
  // The signed-in wallet's position in this token: live with every price tick and own trade, and
  // drawn on the chart as B/S markers.
  const session = useAuth();
  const ethUsd = useEthUsd();
  const myWallet = session.authenticated ? (session.user?.wallet ?? null) : null;
  const position = usePosition({ wallet: myWallet, token: t.address, decimals: t.decimals, priceUsd: priceNow, ethUsd, feed: trades });
  // Simple rail by default; Pro mode (remembered per browser) shows the full panel and stats.
  const pro = useSettings().proMode;
  const desktop = useMediaQuery('(min-width: 1024px)');
  const [sheet, setSheet] = useState<'buy' | 'sell' | null>(null);
  const trading = tradingAvailable();
  const tradeToken = {
    address: t.address as `0x${string}`,
    symbol: t.symbol,
    decimals: t.decimals,
    risk: t.risk,
    verdict: t.verdict,
    createdAt: t.created_at || null,
    mainPool: (t.main_pool as `0x${string}` | null | undefined) ?? null,
    createdBlock: t.created_block,
    priceChange5mPct: live.data.stats?.['5m']?.priceChangePct != null ? Math.abs(live.data.stats['5m'].priceChangePct) : null,
  };
  const stats = <WindowStats t={t} trades={trades} candles={candles} server={live.data.stats} pairs={pairs} priceNow={priceNow} serverNow={serverNow} />;
  const tabs = (
    <Tabs
      tab={tab}
      setTab={setTab}
      holdersCount={t.holders}
      body={
        <>
          {tab === 'trades' && <TradesTable trades={trades} ctx={ctx} supply={supply} serverNow={serverNow} maker={maker} onMaker={showMaker} />}
          {tab === 'holders' && (
            <HoldersTab
              holders={holdersQ.data?.holders ?? null}
              total={holdersQ.data?.total ?? t.holders}
              error={holdersQ.error}
              pending={holdersQ.pending}
              ctx={ctx}
              priceUsd={priceNow}
              decimals={t.decimals}
              onMaker={showMaker}
            />
          )}
          {tab === 'traders' && <TopTradersTab trades={trades} ctx={ctx} priceUsd={priceNow} decimals={t.decimals} serverNow={serverNow} onMaker={showMaker} />}
          {tab === 'early' && (
            <EarlyBuyersTab
              trades={trades}
              fetched={fetched}
              limit={TRADE_LIMIT}
              createdAtMs={new Date(t.created_at).getTime()}
              launchIndexed={t.launch_indexed}
              ctx={ctx}
              priceUsd={priceNow}
              decimals={t.decimals}
              onMaker={showMaker}
            />
          )}
          {tab === 'bubbles' && <BubblesTab address={t.address} />}
          {tab === 'dev' && <DevTokensTab deployer={t.deployer} self={t.address} serverNow={serverNow} />}
        </>
      }
    />
  );

  return (
    <div className={`h-full overflow-y-auto lg:overflow-hidden ${!pro && trading ? 'pb-20 lg:pb-0' : ''}`}>
      <div className="grid gap-2 p-2 lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-2 lg:min-h-0 lg:overflow-hidden">
          <Header t={t} pools={pools} priceNow={priceNow} serverNow={serverNow} />
          {hydrating && (
            <div role="status" className="flex items-center gap-2 rounded-xl border border-brand/20 bg-brand/[0.06] px-3 py-2 text-xs text-ink/85">
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand" />
              <span>
                Rushr is reading this token&apos;s history {live.hydration.source === 'index' ? 'from its index' : live.hydration.source === 'mixed' ? 'from chain and its index' : 'from chain'}.
                Trades, holders and stats fill in as blocks are read; live trades already stream.
              </span>
              {hydrationLabel(live.hydration).detail && <span className="ml-auto shrink-0 font-mono text-muted">{hydrationLabel(live.hydration).detail}</span>}
            </div>
          )}
          {pro && <div className="lg:hidden">{stats}</div>}
          <div className="h-[360px] shrink-0 overflow-hidden rounded-2xl border border-white/[0.06] bg-surface lg:h-auto lg:min-h-[280px] lg:flex-[1.15]">
            <PriceChart
              address={t.address}
              initial={candles}
              seconds={live.data.candles1s}
              supply={supply}
              trades={trades}
              priceUsd={priceNow}
              hydration={live.hydration}
              marks={myWallet ? position.trades : null}
            />
          </div>
          {tabs}
        </div>
        <aside className="flex min-h-0 flex-col gap-2 lg:overflow-y-auto lg:[scrollbar-width:thin]">
          {pro ? (
            <>
              <ModeSwitch />
              <div className="hidden lg:block">{stats}</div>
              {trading ? <TradePanel priceUsd={priceNow} position={position} token={tradeToken} /> : <TradeSoon symbol={t.symbol} />}
              <PoolPanel t={t} pools={pools} supply={supply} serverNow={serverNow} />
              <Safety t={t} />
              <DevRecord t={t} />
            </>
          ) : (
            <>
              {/* On phones the trade card opens from the sticky Buy/Sell bar instead. */}
              {trading ? desktop && <SimpleTrade token={tradeToken} priceUsd={priceNow} /> : <TradeSoon symbol={t.symbol} />}
              <PositionCard t={t} position={position} supply={supply} />
              <ThesisBox t={t} />
              <About
                t={t}
                server={live.data.stats}
                trades={trades}
                candles={candles}
                priceNow={priceNow}
                serverNow={serverNow}
                more={
                  <>
                    {stats}
                    <PoolPanel t={t} pools={pools} supply={supply} serverNow={serverNow} />
                    <Safety t={t} />
                    <DevRecord t={t} />
                  </>
                }
              />
            </>
          )}
        </aside>
      </div>
      {!pro && trading && !desktop && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08] bg-bg/95 p-3 backdrop-blur-sm [padding-bottom:max(0.75rem,env(safe-area-inset-bottom))] lg:hidden">
          <div className="grid grid-cols-2 gap-2">
            <button type="button" onClick={() => setSheet('buy')} className="rounded-xl bg-go py-3 text-[15px] font-semibold text-bg">
              Buy
            </button>
            <button type="button" onClick={() => setSheet('sell')} className="rounded-xl bg-risk-high py-3 text-[15px] font-semibold text-bg">
              Sell
            </button>
          </div>
        </div>
      )}
      {sheet && !desktop && (
        <Sheet onClose={() => setSheet(null)}>
          <SimpleTrade token={tradeToken} priceUsd={priceNow} initialSide={sheet} />
        </Sheet>
      )}
    </div>
  );
}

/** The About card with its own clock, so the per-second window refresh re-renders only this card. */
function About({
  t,
  server,
  trades,
  candles,
  priceNow,
  serverNow,
  more,
}: {
  t: TokenDetail;
  server: ServerStats | null;
  trades: Tx[] | null;
  candles: Candle[] | null;
  priceNow: number | null;
  serverNow: number;
  more: React.ReactNode;
}) {
  const windows = useWindows(server, trades, candles, priceNow, serverNow);
  const nowMs = useNow(serverNow);
  return <AboutCard t={t} windows={windows} trades={trades} nowMs={nowMs} more={more} />;
}

/** Desktop breakpoint, read after mount (false during server render). */
function useMediaQuery(query: string) {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMatch(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** Bottom sheet for the trade card on phones. */
function Sheet({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return createPortal(
    <div className="fixed inset-0 z-[70] flex flex-col justify-end" role="dialog" aria-modal="true" aria-label="Trade">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60" />
      <div className="relative max-h-[92vh] overflow-y-auto rounded-t-3xl bg-bg p-2 [padding-bottom:max(0.5rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/15" />
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Back to the simple rail from Pro mode. */
function ModeSwitch() {
  return (
    <div className="flex shrink-0 items-center justify-between rounded-xl border border-white/[0.06] bg-surface px-3 py-2 text-xs">
      <span className="text-muted">Pro mode</span>
      <button type="button" onClick={() => updateSettings({ proMode: false })} className="font-semibold text-ink/85 hover:text-ink">
        Switch to simple
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ header */

function Header({ t, pools, priceNow, serverNow }: { t: TokenDetail; pools: Pools; priceNow: number | null; serverNow: number }) {
  const [copied, setCopied] = useState(false);
  const now = useNow(serverNow);
  const copy = () => {
    void navigator.clipboard?.writeText(t.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  const created = new Date(t.created_at).getTime();
  // Per-pool merge first; the card's own sum (measured pools only) until pools arrive.
  const liquidity = pools.liquidityUsd ?? t.liquidity_usd ?? null;
  const supply = toWhole(t.total_supply, t.decimals) ?? 0;
  const mcap = priceNow && supply ? priceNow * supply : t.market_cap_usd;
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-2xl border border-white/[0.06] bg-surface px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <TokenAvatar t={t} size={44} badge />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-[-0.02em]">{t.symbol}</h1>
            <span className="max-w-[16ch] truncate text-sm text-muted">{t.name}</span>
            <RiskTag risk={t.risk} />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <button type="button" onClick={copy} className="flex items-center gap-1 font-mono hover:text-ink" title="Copy contract address">
              {short(t.address)} {copied ? <Check size={12} className="text-brand" /> : <Copy size={12} />}
            </button>
            <span>·</span>
            <span>{LAUNCHPAD_LABEL[t.launchpad ?? ''] ?? t.launchpad}</span>
            <span>·</span>
            <span title={known(t.created_at) ? dateTimeUtc(t.created_at) : undefined} className="font-mono">
              {known(t.created_at) ? ageLong(created, now) : 'age —'}
            </span>
            <span>·</span>
            <a href={`${EXPLORER}/token/${t.address}`} target="_blank" rel="noreferrer" className="rounded bg-white/[0.05] px-1.5 py-px hover:text-ink">
              Explorer
            </a>
            <a href={dexscreenerUrl(t.address)} target="_blank" rel="noreferrer" className="rounded bg-white/[0.05] px-1.5 py-px hover:text-ink">
              DexScreener
            </a>
            <SocialLinks t={t} size={14} />
          </div>
          {t.description && (
            <p className="mt-1 max-w-[60ch] truncate text-xs text-ink/70" title={t.description}>
              {t.description}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Stat k="Market cap" v={usd(mcap)} big />
        <Stat k="Price" v={price(priceNow)} />
        <Stat k="Liquidity" v={liquidity == null ? '—' : usd(liquidity)} title={pools.rows.length ? `Across ${pools.rows.length} pools` : 'Not reported for this token yet'} />
        <Stat k="Holders" v={nf.format(t.holders)} />
        <Stat k="ATH mcap" v={usd(t.ath_market_cap_usd)} />
        {t.status !== 'migrated' && t.bonding_progress != null && <Stat k="Bonding" v={pct(t.bonding_progress * 100, 0)} />}
      </div>
    </div>
  );
}

function Stat({ k, v, big, title }: { k: string; v: string; big?: boolean; title?: string }) {
  return (
    <div title={title}>
      <div className="text-[11px] text-muted">{k}</div>
      <div className={`font-mono ${big ? 'text-lg font-semibold' : 'text-sm'}`}>{v}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ rolling windows */

/**
 * 5m/1h/6h/24h tiles like GMGN. Rushr's own numbers update with every trade; when DexScreener
 * knows the token's pools, "All pools" adds the venues our indexer doesn't cover yet.
 */
const SERVER_WINDOW: Record<WindowId, '5m' | '1h' | '6h' | '24h'> = { m5: '5m', h1: '1h', h6: '6h', h24: '24h' };

/** v2 `stats` → the panel's shape. Missing windows read as empty. */
function fromServerStats(s: ServerStats): Record<WindowId, WindowStatsT> {
  const out = {} as Record<WindowId, WindowStatsT>;
  for (const w of WINDOWS) {
    const x = s[SERVER_WINDOW[w.id]];
    out[w.id] = {
      change: x?.priceChangePct ?? null,
      volume: x?.volumeUsd ?? 0,
      trades: (x?.buys ?? 0) + (x?.sells ?? 0),
      buys: x?.buys ?? 0,
      sells: x?.sells ?? 0,
      buyUsd: x?.buyUsd ?? 0,
      sellUsd: x?.sellUsd ?? 0,
      makers: x?.makers ?? 0,
      complete: true,
    };
  }
  return out;
}

/** Window stats (5m/1h/6h/24h): exact from the server on feed v2, else derived from trades and candles. */
function useWindows(server: ServerStats | null, trades: Tx[] | null, candles: Candle[] | null, priceNow: number | null, serverNow: number) {
  const now = useNow(serverNow);
  // Recomputing per second keeps windows sliding; it's a single pass over the trade list.
  const derived = useMemo(
    () => (!server && trades && candles ? windowStats(trades, candles, Math.floor(now / 1000), priceNow) : null),
    [server, trades, candles, now, priceNow],
  );
  return useMemo(() => (server ? fromServerStats(server) : derived), [server, derived]);
}

function WindowStats({
  t,
  trades,
  candles,
  server,
  pairs,
  priceNow,
  serverNow,
}: {
  t: TokenDetail;
  trades: Tx[] | null;
  candles: Candle[] | null;
  /** v2 rolling windows from the server: exact, so they replace the ones derived here. */
  server: ServerStats | null;
  pairs: Pair[] | null;
  priceNow: number | null;
  serverNow: number;
}) {
  const [w, setW] = useState<WindowId>('h24');
  const [chosen, setSource] = useState<'rushr' | 'all' | null>(null);
  const hasPairs = !!pairs?.length;
  // Until the user picks: Rushr when the server sends exact stats (v2 indexes every venue), else
  // "all pools" for plain-pool tokens DexScreener knows (venues the old index doesn't cover).
  const source = chosen ?? (!server && hasPairs && t.launchpad === 'uniswap-v4' ? 'all' : 'rushr');
  const ours = useWindows(server, trades, candles, priceNow, serverNow);
  const all = useMemo(() => (hasPairs ? aggregate(pairs!) : null), [hasPairs, pairs]);
  const useAll = source === 'all' && all;
  const tile = (id: WindowId) => (useAll ? all.byWindow[id].change : (ours?.[id].change ?? null));
  const cur = useAll
    ? { volume: all.byWindow[w].volume, buys: all.byWindow[w].buys, sells: all.byWindow[w].sells, buyUsd: null, sellUsd: null, makers: null, complete: true }
    : ours?.[w];
  const net = cur && cur.buyUsd != null && cur.sellUsd != null ? cur.buyUsd - cur.sellUsd : null;
  const total = cur ? cur.buys + cur.sells : 0;
  const buyShare = total ? (cur!.buys / total) * 100 : 50;
  const usdTotal = cur?.buyUsd != null && cur.sellUsd != null ? cur.buyUsd + cur.sellUsd : 0;
  const usdShare = usdTotal ? (cur!.buyUsd! / usdTotal) * 100 : 50;

  return (
    <div className="rounded-2xl border border-white/[0.06] bg-surface p-2">
      <div className="grid grid-cols-4 gap-1">
        {WINDOWS.map((x) => {
          const ch = tile(x.id);
          return (
            <button
              key={x.id}
              type="button"
              onClick={() => setW(x.id)}
              className={`rounded-xl px-1 py-1.5 text-center transition ${w === x.id ? 'bg-white/[0.07] ring-1 ring-white/10' : 'hover:bg-white/[0.03]'}`}
            >
              <div className="text-[11px] text-muted">{x.label}</div>
              <div className={`font-mono text-[13px] font-semibold ${ch == null ? 'text-muted' : ch >= 0 ? 'text-brand' : 'text-risk-high'}`}>
                {ch == null ? (ours || useAll ? '—' : '…') : pctSigned(ch, Math.abs(ch) >= 100 ? 0 : 1)}
              </div>
            </button>
          );
        })}
      </div>
      {!cur ? (
        <div className="mt-2 h-[74px] animate-pulse rounded-xl bg-white/[0.03]" />
      ) : (
        <div className="mt-2 space-y-2 px-1.5 pb-1 text-[11px]">
          <div className="grid grid-cols-4 gap-1">
            <Mini k="Vol" v={usd(cur.volume)} />
            <Mini k="Buys" v={nf.format(cur.buys)} tone="text-brand" />
            <Mini k="Sells" v={nf.format(cur.sells)} tone="text-risk-high" />
            <Mini k="Net buy" v={net == null ? '—' : usdSigned(net)} tone={net == null ? '' : net >= 0 ? 'text-brand' : 'text-risk-high'} />
          </div>
          <Ratio left={buyShare} label={`${nf.format(cur.buys)} / ${nf.format(cur.sells)} txns`} />
          {usdTotal > 0 && <Ratio left={usdShare} label={`${usd(cur.buyUsd)} / ${usd(cur.sellUsd)}`} />}
          <div className="flex items-center justify-between text-[10px] text-muted">
            <span>
              {cur.makers != null && <>{nf.format(cur.makers)} makers · </>}
              {useAll ? `${pairs!.length} pools via DexScreener` : cur.complete ? 'Rushr index' : 'Buy/sell split from recent trades'}
            </span>
            {hasPairs && (
              <span className="flex rounded-md bg-white/[0.04] p-px">
                {(['rushr', 'all'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSource(s)}
                    className={`rounded px-1.5 py-px ${source === s ? 'bg-white/[0.1] text-ink' : 'hover:text-ink'}`}
                  >
                    {s === 'rushr' ? 'Rushr' : 'All pools'}
                  </button>
                ))}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Mini({ k, v, tone = '' }: { k: string; v: string; tone?: string }) {
  return (
    <div>
      <div className="text-muted">{k}</div>
      <div className={`font-mono text-xs ${tone}`}>{v}</div>
    </div>
  );
}

function Ratio({ left, label }: { left: number; label: string }) {
  return (
    <div>
      <div className="flex h-1 overflow-hidden rounded-full bg-risk-high/70">
        <span className="h-full bg-brand transition-[width] duration-500" style={{ width: `${left}%` }} />
      </div>
      <div className="mt-0.5 font-mono text-[10px] text-muted">{label}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ right rail */

/** Shown while trading is off (NEXT_PUBLIC_SWAP_ENABLED unset): what the trade box will do. */
function TradeSoon({ symbol }: { symbol: string }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('0.1');
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-surface p-4">
      <div className="grid grid-cols-2 rounded-xl bg-white/[0.04] p-1 text-sm font-semibold">
        {(['buy', 'sell'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSide(s)}
            className={`rounded-lg py-2 capitalize transition ${side === s ? (s === 'buy' ? 'bg-brand text-bg' : 'bg-risk-high text-bg') : 'text-muted'}`}
          >
            {s}
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center rounded-xl border border-white/[0.06] bg-bg px-3 py-2.5">
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
          inputMode="decimal"
          aria-label="Amount"
          className="w-full bg-transparent font-mono text-lg outline-none"
        />
        <span className="font-mono text-sm text-muted">{side === 'buy' ? 'ETH' : '%'}</span>
      </div>
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        {(side === 'buy' ? ['0.01', '0.05', '0.1', '0.5'] : ['25', '50', '75', '100']).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setAmount(v)}
            className={`rounded-lg border py-1.5 font-mono text-xs transition ${amount === v ? 'border-white/20 text-ink' : 'border-white/[0.06] text-muted hover:text-ink'}`}
          >
            {v}
            {side === 'sell' ? '%' : ''}
          </button>
        ))}
      </div>
      <button
        type="button"
        disabled
        className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-white/[0.06] py-3 text-sm font-semibold text-muted"
      >
        <Lightning size={14} weight="fill" /> Trading opens soon
      </button>
      <p className="mt-2 text-center text-[11px] text-muted">
        {side === 'buy' ? 'Buy' : 'Sell'} ${symbol} non-custodially, from this screen.
      </p>
    </div>
  );
}

const DEX_LABEL: Record<string, string> = {
  uniswap: 'Uniswap', ramses: 'Ramses', aero: 'Aero', metric: 'Metric', topaz: 'Topaz', nami: 'Nami', pons: 'PONS curve', curve: 'Curve',
};
const SOURCE_NOTE = {
  rushr: 'Liquidity from Rushr’s index.',
  dexscreener: 'Liquidity via DexScreener.',
  mixed: 'Liquidity from Rushr’s index; DexScreener fills pools we don’t measure yet.',
} as const;

function PoolPanel({ t, pools, supply, serverNow }: { t: TokenDetail; pools: Pools; supply: number; serverNow: number }) {
  const [all, setAll] = useState(false);
  const now = useNow(serverNow);
  const [copied, setCopied] = useState(false);
  const pool = t.main_pool ?? null;
  const quote = quoteLabel(t.quote);
  const rows = pools.rows;
  const list = all ? rows : rows.slice(0, 4);
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Pools & liquidity</h2>
        {pools.liquidityUsd != null && <span className="font-mono text-sm">{usd(pools.liquidityUsd)}</span>}
      </div>
      <dl className="mt-3 space-y-2 text-[13px]">
        <Row k="Pair" v={`${t.symbol} / ${quote}`} />
        <Row k="Venue" v={LAUNCHPAD_LABEL[t.launchpad ?? ''] ?? t.launchpad ?? '—'} />
        {pool && (
          <div className="flex justify-between gap-3">
            <dt className="text-muted">Main pool</dt>
            <dd>
              <button
                type="button"
                className="flex items-center gap-1 font-mono text-xs hover:text-ink"
                onClick={() =>
                  void navigator.clipboard?.writeText(pool).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  })
                }
                title="Copy pool id"
              >
                {short(pool)} {copied ? <Check size={11} className="text-brand" /> : <Copy size={11} />}
              </button>
            </dd>
          </div>
        )}
        <Row k="Supply" v={compact(supply)} />
        <Row k="Created" v={known(t.created_at) ? `${dateUtc(t.created_at)} · ${ageLong(new Date(t.created_at).getTime(), now).split(' ')[0]} ago` : '—'} />
        {t.status !== 'migrated' && t.bonding_progress != null && (
          <div>
            <div className="flex justify-between">
              <dt className="text-muted">Bonding curve</dt>
              <dd className="font-mono">{pct(t.bonding_progress * 100, 1)}</dd>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.min(100, t.bonding_progress * 100)}%` }} />
            </div>
          </div>
        )}
      </dl>
      {pools.loading ? (
        <div className="mt-3 h-14 animate-pulse rounded-xl bg-white/[0.03]" />
      ) : rows.length ? (
        <div className="mt-3 border-t border-white/[0.05] pt-3">
          <div className="mb-1.5 flex justify-between text-[10px] uppercase tracking-wider text-muted">
            <span>{rows.length} pools</span>
            <span>Liquidity · 24h vol</span>
          </div>
          <ul className="space-y-1">
            {list.map((p) => (
              <li key={p.id}>
                <a
                  href={p.url}
                  target="_blank"
                  rel="noreferrer"
                  title={p.liquidityFrom === 'dexscreener' ? 'Liquidity via DexScreener' : undefined}
                  className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-xs hover:bg-white/[0.03]"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {DEX_LABEL[p.dex] ?? p.dex}
                    {p.version && p.version !== 'curve' && <span className="ml-1 text-muted">{p.version}</span>}
                    <span className="ml-1 text-muted">/ {p.quote}</span>
                  </span>
                  <span className={`font-mono ${p.liquidityFrom === 'dexscreener' && pools.source === 'mixed' ? 'text-ink/60' : ''}`}>
                    {usd(p.liquidityUsd)}
                  </span>
                  <span className="w-14 text-right font-mono text-muted">{usd(p.volume24hUsd)}</span>
                </a>
              </li>
            ))}
          </ul>
          {rows.length > 4 && (
            <button type="button" onClick={() => setAll((a) => !a)} className="mt-1 px-1.5 text-[11px] text-muted hover:text-ink">
              {all ? 'Show fewer' : `Show all ${rows.length}`}
            </button>
          )}
          {pools.source && <p className="mt-2 px-1.5 text-[10px] text-muted">{SOURCE_NOTE[pools.source]}</p>}
        </div>
      ) : (
        <p className="mt-3 border-t border-white/[0.05] pt-3 text-[11px] text-muted">
          {t.status === 'migrated' || t.launchpad === 'uniswap-v4' ? 'Liquidity figures for this pool are coming soon.' : 'Still on its bonding curve: liquidity is the curve itself.'}
        </p>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className="truncate font-mono">{v}</dd>
    </div>
  );
}

const REASON_ICON = { high: WarningOctagon, medium: Warning, low: CheckCircle, info: Info } as const;
const REASON_COLOR = { high: 'text-risk-high', medium: 'text-risk-medium', low: 'text-brand', info: 'text-muted' } as const;

function Safety({ t }: { t: TokenDetail }) {
  const reasons: SignalReason[] = t.signals?.reasons ?? [];
  const rows: [string, string, boolean][] = [
    ['Top 10 holders', pct(t.top10_pct), (t.top10_pct ?? 0) >= 30],
    ['Dev holds', pct(t.dev_pct), (t.dev_pct ?? 0) >= 10],
    ['Launch bundle', pct(t.bundled_pct), (t.bundled_pct ?? 0) >= 20],
    [`Snipers${t.signals?.sniperCount ? ` (${t.signals.sniperCount})` : ''}`, pct(t.snipers_pct), (t.snipers_pct ?? 0) >= 20],
    ['Insiders', pct(t.insiders_pct), (t.insiders_pct ?? 0) >= 10],
    ['Fresh wallets', pct(t.fresh_pct), (t.fresh_pct ?? 0) >= 30],
    ['Airdropped holders', t.airdropped == null ? '—' : nf.format(t.airdropped), (t.airdropped ?? 0) > 10],
    ['Copycat', t.copycat == null ? '—' : t.copycat ? 'Yes' : 'No', !!t.copycat],
  ];
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Safety check</h2>
        <RiskTag risk={t.risk} />
      </div>
      {t.verdict && <p className={`mt-3 text-sm leading-relaxed ${riskText(t.risk)}`}>{t.verdict}</p>}
      {!t.launch_indexed && <p className="mt-2 text-xs text-muted">Found after launch. Launch-time checks fill in once its first blocks are indexed.</p>}
      <dl className="mt-4 space-y-2 text-[13px]">
        {rows.map(([k, v, bad]) => (
          <div key={k} className="flex justify-between">
            <dt className="text-muted">{k}</dt>
            <dd className={`font-mono ${bad ? 'text-risk-high' : ''}`}>{v}</dd>
          </div>
        ))}
      </dl>
      {reasons.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-t border-white/[0.05] pt-3">
          {reasons.map((r) => {
            const Icon = REASON_ICON[r.level] ?? Info;
            return (
              <li key={r.text} className="flex gap-2 text-xs">
                <Icon size={14} weight="fill" className={`mt-px shrink-0 ${REASON_COLOR[r.level] ?? 'text-muted'}`} />
                <span className="text-ink/85">{r.text}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function DevRecord({ t }: { t: TokenDetail }) {
  const d = t.dev;
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-surface p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Dev record</h2>
        {t.serial_launcher && <span className="rounded-md bg-risk-high/15 px-1.5 py-0.5 text-[10px] font-semibold text-risk-high">serial launcher</span>}
      </div>
      <a href={`${EXPLORER}/address/${t.deployer}`} target="_blank" rel="noreferrer" className="mt-1 block font-mono text-xs text-muted hover:text-ink">
        {short(t.deployer)}
      </a>
      {d ? (
        <div className="mt-3 grid grid-cols-2 gap-3 text-[13px]">
          <DevStat k="Launches" v={nf.format(d.launches)} />
          <DevStat k="This week" v={nf.format(d.launches_7d)} bad={d.launches_7d >= 5} />
          <DevStat k="Graduated" v={nf.format(d.migrated)} good={d.migrated > 0} />
          <DevStat k="Rugged" v={nf.format(d.rugs)} bad={d.rugs > 0} />
          <DevStat k="Best peak" v={usd(d.best_peak_mcap_usd ? Number(d.best_peak_mcap_usd) : null)} />
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted">No history yet.</p>
      )}
    </div>
  );
}

function DevStat({ k, v, bad, good }: { k: string; v: string; bad?: boolean; good?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{k}</div>
      <div className={`font-mono ${bad ? 'text-risk-high' : good ? 'text-brand' : ''}`}>{v}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ bottom tabs */

type Tab = 'trades' | 'holders' | 'traders' | 'early' | 'bubbles' | 'dev';

function Tabs({ tab, setTab, holdersCount, body }: { tab: Tab; setTab: (t: Tab) => void; holdersCount: number; body: React.ReactNode }) {
  const tabs: [Tab, string][] = [
    ['trades', 'Trades'],
    ['holders', `Holders ${nf.format(holdersCount)}`],
    ['traders', 'Top traders'],
    ['early', 'Early buyers'],
    ['bubbles', 'Bubble map'],
    ['dev', "Dev's tokens"],
  ];
  return (
    <div className="flex h-[560px] shrink-0 flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-surface lg:h-auto lg:min-h-0 lg:flex-1 lg:shrink">
      <div className="flex gap-1 overflow-x-auto border-b border-white/[0.05] px-2 py-2 [scrollbar-width:none]">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium ${tab === id ? 'bg-white/[0.08] text-ink' : 'text-muted hover:text-ink'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">{body}</div>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, DotsThree, GearSix, Key, PencilSimple, Robot, ShareNetwork, User, XLogo } from '@phosphor-icons/react';
import { auth, displayName, useAuth, type AuthUser } from '@/lib/auth';
import { useWalletHoldings } from '@/lib/holdings';
import { age, compact, countFmt, dateUtc, short, usd, usdSigned } from '@/lib/format';
import { useMe } from '@/lib/members';
import { useNow } from '@/lib/now';
import {
  followRef,
  useCallouts,
  useProfileMember,
  useRelationship,
  useSuggestions,
  usePnlHistory,
  useWalletPnl,
  useWalletTrades,
  type PnlRange,
  type PnlSummary,
  type Position,
  type ProfileMember,
  type Suggestion,
  type WalletTrade,
} from '@/lib/profile';
import { PnlChart } from './pnl-chart';
import { ShareCard, type ShareTarget } from '../share-card';
import { CallCard } from '../calls-feed';
import type { Callout } from '@/lib/callouts';
import { MemberAvatar } from '../member-avatar';
import { RunsOnBadge } from '../runs-on';
import { iconSrc, TokenAvatar } from '../bits';
import { EditProfile } from './edit-profile';
import { WalletOverview } from '../wallet-overview';

/**
 * Profile pages in FOMO's structure with Rushr's look: a banner header, then portfolio (value, PnL,
 * cash, positions), activity (feed / transactions) and a "follow top traders" rail. /me adds the
 * cash card's Deposit / Withdraw and editing.
 */

type View = {
  own: boolean;
  handle: string | null;
  member: ProfileMember | null;
  name: string;
  wallet: `0x${string}` | null;
  avatarSeed: string;
  avatarUrl: string | null;
};

/* ------------------------------------------------------------------ share cards */

const CARD_RANGES = [
  { id: '24h', label: '24H' },
  { id: '7d', label: '7D' },
  { id: '30d', label: '30D' },
  { id: 'all', label: 'ALL' },
];

/** The profile's PnL card (lib/card): shared links preview as the card for the chosen range. */
function profileShare(handle: string, own: boolean): ShareTarget {
  return {
    title: own ? 'Share your PnL' : `Share @${handle}'s PnL`,
    ranges: CARD_RANGES,
    defaultRange: 'all',
    image: (r) => `/card/profile/${handle}?range=${r}`,
    link: (r) => `${window.location.origin}/u/${handle}?card=${r}`,
    text: () => (own ? 'My PnL on @rushrtrade 📈' : `@${handle}'s PnL on @rushrtrade 📈`),
    filename: (r) => `rushr-${handle}-pnl-${r}.png`,
  };
}

/** One position's card: realized result when closed, open PnL while held. */
function positionShare(handle: string, own: boolean, p: Position, pnl: number, pnlPct: number | null): ShareTarget {
  const result = pnlPct != null ? `${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : usdSigned(pnl);
  return {
    title: own ? `Share your $${p.symbol} trade` : `Share @${handle}'s $${p.symbol} trade`,
    image: () => `/card/position/${handle}/${p.token}`,
    link: () => `${window.location.origin}/token/${p.token}?pnl=${handle}`,
    text: () => `${result} on $${p.symbol} ${own ? '' : `by @${handle} `}on @rushrtrade ${pnl >= 0 ? '📈' : '📉'}`.replace(/\s+/g, ' '),
    filename: () => `rushr-${handle}-${p.symbol.toLowerCase()}.png`,
  };
}

/* ------------------------------------------------------------------ entry points */

export function MyProfile() {
  const { enabled, ready, authenticated, user } = useAuth();
  const me = useMe();
  const handle = me?.status === 'registered' ? me.member.handle : null;
  const [tick, setTick] = useState(0);
  const full = useProfileMember(handle, tick);
  if (!enabled) return <Notice title="Profiles open with sign-in" body="Sign-in isn't enabled on this build." />;
  if (!authenticated || !user)
    return (
      <Notice
        title={ready ? 'Sign in to see your profile' : 'Loading…'}
        body="Your profile is where you fund your wallet, see your positions and share your PnL."
        action={
          ready ? (
            <button type="button" onClick={() => auth.login()} className="rounded-xl bg-ink px-5 py-2.5 text-sm font-semibold text-bg hover:bg-white">
              Sign in
            </button>
          ) : null
        }
      />
    );
  const member = full.state === 'ready' ? full.data : null;
  const view: View = {
    own: true,
    handle,
    member,
    name: member?.displayName ?? (handle ? handle : displayName(user)),
    wallet: user.wallet,
    avatarSeed: user.wallet ?? seedOf(user),
    avatarUrl: member?.avatarUrl ?? null,
  };
  return <ProfilePage view={view} onEdited={() => setTick((t) => t + 1)} />;
}

export function PublicProfile({ handle }: { handle: string }) {
  const m = useProfileMember(handle);
  if (m.state === 'loading') return <Skeleton />;
  if (m.state === 'unavailable') return <Notice title={`@${handle}`} body="Public profiles open with the beta's social features. Check back soon." />;
  const member = m.data;
  const view: View = {
    own: false,
    handle: member.handle,
    member,
    name: member.displayName ?? member.handle,
    wallet: member.wallet as `0x${string}`,
    avatarSeed: member.wallet,
    avatarUrl: member.avatarUrl,
  };
  return <ProfilePage view={view} />;
}

const seedOf = (u: AuthUser) => `0x${[...u.id].map((c) => c.charCodeAt(0).toString(16)).join('').slice(0, 40).padEnd(40, '0')}`;

/* ------------------------------------------------------------------ page */

function ProfilePage({ view, onEdited }: { view: View; onEdited?: () => void }) {
  const pnl = useWalletPnl(view.wallet);
  const holdings = useWalletHoldings(view.wallet);
  const positions = pnl.state === 'ready' ? pnl.data.positions : [];
  const summary = pnl.state === 'ready' ? pnl.data.summary : null;
  // Everything the wallet holds at today's prices (ETH, USDG and tokens, read on-chain).
  const total = holdings.totalUsd;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1400px] pb-8">
        <Header view={view} summary={summary} onEdited={onEdited} />
        <div className="grid gap-3 px-3 sm:px-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)_300px]">
          <div className="min-w-0 space-y-3">
            <Portfolio wallet={view.wallet} total={total} summary={summary} loading={pnl.state === 'loading'} />
            {view.own && <WalletOverview wallet={view.wallet} holdings={holdings} menu={<WalletMenu />} />}
            <Positions state={pnl.state} positions={positions} handle={view.handle} own={view.own} />
          </div>
          <div className="min-w-0">
            <Activity handle={view.handle} wallet={view.wallet} />
          </div>
          <div className="min-w-0 space-y-3 lg:col-span-2 xl:col-span-1">
            <TopTraders exclude={view.handle} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ header */

function Header({ view, summary, onEdited }: { view: View; summary: PnlSummary | null; onEdited?: () => void }) {
  const { authenticated } = useAuth();
  const m = view.member;
  const rel = useRelationship(view.own ? null : view.handle, authenticated);
  const [editing, setEditing] = useState(false);
  const [shared, setShared] = useState(false);
  const [card, setCard] = useState(false);
  // Members get the PnL card popup; a wallet without a handle can only share its page link.
  const share = async () => {
    if (view.handle) return setCard(true);
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShared(true);
      setTimeout(() => setShared(false), 1500);
    } catch {
      // not allowed
    }
  };
  return (
    <section>
      <div className="relative h-36 overflow-hidden border-b border-white/[0.06] sm:h-48">
        {m?.bannerUrl ? (
          <img src={iconSrc(m.bannerUrl)} alt="" className="size-full object-cover" />
        ) : (
          <picture>
            <source srcSet="/art/forum-1280.avif" type="image/avif" />
            <img src="/art/forum-1280.webp" alt="" className="size-full object-cover object-[50%_35%] opacity-60" />
          </picture>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/30 to-transparent" />
      </div>
      <div className="px-3 sm:px-4">
        <div className="-mt-12 flex flex-wrap items-end gap-3 sm:-mt-14">
          <span className="block shrink-0 rounded-full border-4 border-bg bg-bg">
            <MemberAvatar member={view.member} wallet={view.wallet} label={view.name} size={96} />
          </span>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2 pb-1">
            <Count label="Following" value={m?.following ?? null} />
            <Count label="Followers" value={m?.followers ?? null} />
            <button type="button" onClick={() => void share()} className="flex items-center gap-1.5 rounded-xl border border-white/[0.08] px-3 py-2 text-sm text-muted hover:text-ink">
              <ShareNetwork size={15} /> {shared ? 'Link copied' : 'Share'}
            </button>
            {view.own ? (
              <button
                type="button"
                disabled={!m}
                title={m ? undefined : 'Pick a handle first'}
                onClick={() => setEditing(true)}
                className="flex items-center gap-1.5 rounded-xl bg-ink px-3 py-2 text-sm font-semibold text-bg hover:bg-white disabled:opacity-40"
              >
                <PencilSimple size={15} /> Edit profile
              </button>
            ) : rel.state && !rel.state.self ? (
              <button
                type="button"
                onClick={() => void rel.toggle()}
                disabled={rel.busy}
                className={`rounded-xl px-4 py-2 text-sm font-semibold ${rel.state.following ? 'border border-white/[0.12] text-ink hover:border-risk-high/40 hover:text-risk-high' : 'bg-brand text-bg hover:brightness-110'}`}
              >
                {rel.state.following ? 'Following' : 'Follow'}
              </button>
            ) : !authenticated ? (
              <button type="button" onClick={() => auth.login()} className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-bg hover:brightness-110">
                Follow
              </button>
            ) : null}
          </div>
        </div>
        <div className="mt-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-[-0.02em]">{view.name}</h1>
            <span className="inline-flex items-center gap-1 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-semibold text-muted">
              {m?.kind === 'agent' ? <Robot size={12} weight="bold" /> : <User size={12} weight="bold" />}
              {m?.kind === 'agent' ? 'Agent' : 'Human'}
            </span>
            {m?.kind === 'agent' && <RunsOnBadge runsOn={m.runsOn} size="md" />}
            {rel.state?.followedBy && <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[11px] text-muted">Follows you</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
            {view.handle && <span>@{view.handle}</span>}
            {m?.x && (
              <a href={`https://x.com/${m.x.username}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink">
                <XLogo size={13} weight="bold" /> {m.x.username}
              </a>
            )}
            {view.wallet && <span className="font-mono text-xs">{short(view.wallet)}</span>}
            {m?.owner && (
              <span>
                Owned by{' '}
                <Link href={`/u/${m.owner.handle}`} className="text-ink/80 hover:text-ink">
                  @{m.owner.handle}
                </Link>
              </span>
            )}
          </div>
          {m?.bio ? (
            <p className="mt-2 max-w-2xl text-sm text-ink/85">{m.bio}</p>
          ) : view.own && !view.handle ? (
            <p className="mt-2 text-sm text-muted">Pick your handle to get a public profile.</p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            <span>
              Avg hold <span className="text-ink/80">—</span>
            </span>
            <span>
              Trades <span className="font-mono text-ink/80">{countFmt(summary?.trades)}</span>
            </span>
            {m?.createdAt && <span>Joined {dateUtc(m.createdAt)}</span>}
          </div>
          {!!m?.agents?.length && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted">Agents</span>
              {m.agents.map((a) => (
                <Link key={a.id} href={`/u/${a.handle}`} className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] px-2 py-0.5 text-xs hover:border-white/20">
                  <Robot size={12} /> @{a.handle}
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
      {card && view.handle && <ShareCard target={profileShare(view.handle, view.own)} onClose={() => setCard(false)} />}
      {editing && m && (
        <EditProfile
          member={m}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onEdited?.();
          }}
        />
      )}
      <div className="h-4" />
    </section>
  );
}

function Count({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="px-2 text-center">
      <div className="font-mono text-base font-semibold leading-tight">{countFmt(value)}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ portfolio */

type Range = PnlRange;
const RANGE_LABEL: Record<Range, string> = { '24h': '24H', '7d': '7D', '30d': '30D', all: 'ALL' };

function Portfolio({ wallet, total, summary, loading }: { wallet: string | null; total: number | null; summary: PnlSummary | null; loading: boolean }) {
  const [range, setRange] = useState<Range>('7d');
  const history = usePnlHistory(wallet, range);
  const hist = history.state === 'ready' ? history.data : null;
  const realized =
    range === '24h' ? summary?.realized_24h_usd : range === '7d' ? summary?.realized_7d_usd : range === '30d' ? summary?.realized_30d_usd : summary?.realized_usd;
  const allPnl = summary ? (summary.realized_usd ?? 0) + (summary.unrealized_usd ?? 0) : null;
  // The chart's own total is read live from the trades; the summary refreshes every few minutes.
  const value = range === 'all' ? allPnl : (hist?.realizedUsd ?? realized ?? null);
  const up = (value ?? 0) >= 0;
  return (
    <section className="rounded-2xl border border-white/[0.06] bg-surface p-4">
      <div className="text-xs text-muted">Portfolio value</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-3xl font-semibold tracking-tight">{loading && total == null ? '…' : total == null ? '—' : usd(total)}</span>
        {value != null && (
          <span className={`flex items-center gap-0.5 font-mono text-sm ${up ? 'text-brand' : 'text-risk-high'}`}>
            {up ? <ArrowUp size={12} weight="bold" /> : <ArrowDown size={12} weight="bold" />}
            {usdSigned(value)} <span className="ml-1 font-sans text-xs text-muted">{range === 'all' ? 'all-time PnL' : `realized, ${RANGE_LABEL[range]}`}</span>
          </span>
        )}
      </div>
      <div className="mt-3 flex gap-1">
        {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
          <button key={r} type="button" onClick={() => setRange(r)} className={`rounded-lg px-2.5 py-1 font-mono text-xs ${range === r ? 'bg-white/[0.08] text-ink' : 'text-muted hover:text-ink'}`}>
            {RANGE_LABEL[r]}
          </button>
        ))}
      </div>
      <PnlChart history={hist} loading={history.state === 'loading'} label={`Realized PnL · ${RANGE_LABEL[range]}`} />
    </section>
  );
}

/** The wallet card's ⋯ menu: key export and trading settings. */
function WalletMenu() {
  const [menu, setMenu] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  return (
    <div className="relative">
      <button type="button" onClick={() => setMenu((m) => !m)} aria-label="More" aria-expanded={menu} className="rounded-lg p-1.5 text-muted hover:bg-white/[0.05] hover:text-ink">
        <DotsThree size={20} weight="bold" />
      </button>
      {menu && (
        <div role="menu" className="absolute right-0 top-9 z-20 w-48 overflow-hidden rounded-xl border border-white/[0.08] bg-surface-2 p-1 shadow-xl">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              setExportError(null);
              auth.exportWallet().catch((e: Error) => setExportError(e.message || 'Export failed'));
            }}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-muted hover:bg-white/[0.04] hover:text-ink"
          >
            <Key size={15} /> Export private key
          </button>
          <Link href="/settings" role="menuitem" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted hover:bg-white/[0.04] hover:text-ink">
            <GearSix size={15} /> Trading settings
          </Link>
        </div>
      )}
      {exportError && <p className="absolute right-0 top-9 w-56 rounded-lg bg-surface-2 p-2 text-xs text-risk-high">{exportError}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ positions */

const DUST_USD = 1;

function Positions({ state, positions, handle, own }: { state: 'loading' | 'ready' | 'unavailable'; positions: Position[]; handle: string | null; own: boolean }) {
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [dust, setDust] = useState(false);
  const [sharing, setSharing] = useState<ShareTarget | null>(null);
  const rows = useMemo(() => {
    const all = positions.map((p) => {
      const held = heldTokens(p);
      const value = Math.max(0, p.cost_basis_usd + p.unrealized_usd);
      const pnl = p.realized_usd + p.unrealized_usd;
      return { p, held, value, pnl, pnlPct: p.bought_usd > 0 ? (pnl / p.bought_usd) * 100 : null, open: held > 0 };
    });
    const shown = all.filter((r) => (tab === 'open' ? r.open : !r.open)).filter((r) => tab === 'closed' || dust || r.value >= DUST_USD);
    // Closed: most recent exit first (open keeps the API's order, biggest value first).
    if (tab === 'closed') shown.sort((a, b) => (b.p.last_trade_at ?? '').localeCompare(a.p.last_trade_at ?? ''));
    return shown;
  }, [positions, tab, dust]);
  // Copycats share tickers: when two rows have the same symbol, show each one's contract address.
  const twins = useMemo(() => {
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(r.p.symbol, (seen.get(r.p.symbol) ?? 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([s]) => s));
  }, [rows]);
  const closedTotal = tab === 'closed' ? rows.reduce((s, r) => s + r.p.realized_usd, 0) : null;
  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-surface">
      <div className="flex items-center gap-1 border-b border-white/[0.05] px-3 py-2">
        <h2 className="mr-2 text-sm font-semibold">Positions</h2>
        {(['open', 'closed'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setTab(t)} className={`rounded-lg px-2.5 py-1 text-xs capitalize ${tab === t ? 'bg-white/[0.08] text-ink' : 'text-muted hover:text-ink'}`}>
            {t}
          </button>
        ))}
        {closedTotal != null && rows.length > 0 && (
          <span className="ml-auto font-mono text-[11px] text-muted">
            {rows.length} closed · <span className={closedTotal >= 0 ? 'text-brand' : 'text-risk-high'}>{usdSigned(closedTotal)}</span>
          </span>
        )}
        {tab === 'open' && (
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
            <input type="checkbox" checked={dust} onChange={(e) => setDust(e.target.checked)} className="accent-[var(--color-brand)]" />
            Show dust
          </label>
        )}
      </div>
      {state === 'loading' ? (
        <Rows />
      ) : state === 'unavailable' ? (
        <Empty text="Positions are being computed." sub="They fill in as Rushr finishes indexing past trades." />
      ) : !rows.length ? (
        <Empty text={tab === 'open' ? 'No open positions.' : 'No closed positions yet.'} />
      ) : (
        <ul>
          {rows.map(({ p, held, value, pnl, pnlPct, open }) => {
            const tone = pnl >= 0 ? 'text-brand' : 'text-risk-high';
            const pct = pnlPct != null ? `${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : null;
            return (
              <li key={p.token} className="flex items-center border-t border-white/[0.03] first:border-0 hover:bg-white/[0.02]">
                <Link href={`/token/${p.token}`} className="flex min-w-0 flex-1 items-center gap-3 py-2.5 pl-3">
                  <TokenAvatar t={{ address: p.token, symbol: p.symbol, launchpad: null, image_url: p.image_url }} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="truncate text-sm font-semibold">{p.symbol}</span>
                      {twins.has(p.symbol) && <span className="font-mono text-[10px] text-muted">{short(p.token)}</span>}
                    </span>
                    <span className="block font-mono text-[11px] text-muted">
                      {open
                        ? `${compact(held)} ${p.symbol}`
                        : `Bought ${usd(p.bought_usd)} · Sold ${usd(p.sold_usd)}${p.last_trade_at ? ` · ${age(Date.parse(p.last_trade_at), Date.now())} ago` : ''}`}
                    </span>
                  </span>
                  <span className="text-right font-mono">
                    {open ? (
                      <>
                        <span className="block text-sm">{value >= 0.01 ? usd(value) : '—'}</span>
                        <span className={`block text-[11px] ${tone}`}>{pct ?? usdSigned(pnl)}</span>
                      </>
                    ) : (
                      <>
                        <span className={`block text-sm ${tone}`}>{usdSigned(p.realized_usd)}</span>
                        {pct && <span className={`block text-[11px] ${tone} opacity-80`}>{pct}</span>}
                      </>
                    )}
                  </span>
                </Link>
                {handle ? (
                  <button
                    type="button"
                    aria-label={`Share the ${p.symbol} trade`}
                    title="Share"
                    onClick={() => setSharing(positionShare(handle, own, p, open ? pnl : p.realized_usd, open ? pnlPct : p.bought_usd > 0 ? (p.realized_usd / p.bought_usd) * 100 : null))}
                    className="mx-1.5 shrink-0 rounded-lg p-2 text-muted transition hover:bg-white/[0.05] hover:text-ink"
                  >
                    <ShareNetwork size={15} />
                  </button>
                ) : (
                  <span className="w-3 shrink-0" />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {sharing && <ShareCard target={sharing} onClose={() => setSharing(null)} />}
    </section>
  );
}

/** Whole tokens held (positions carry raw amounts; default 18 decimals until the API sends them). */
function heldTokens(p: Position): number {
  try {
    const d = p.decimals ?? 18;
    const raw = BigInt(p.held_tokens || '0');
    const shift = Math.max(0, d - 6);
    return Number(raw / 10n ** BigInt(shift)) / 10 ** (d - shift);
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ activity */

function Activity({ handle, wallet }: { handle: string | null; wallet: string | null }) {
  const [tab, setTab] = useState<'calls' | 'tx'>('calls');
  const [side, setSide] = useState<'all' | 'buy' | 'sell'>('all');
  const [min, setMin] = useState(0);
  const callouts = useCallouts(handle);
  const trades = useWalletTrades(tab === 'tx' ? wallet : null);
  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-surface">
      <div className="flex flex-wrap items-center gap-1 border-b border-white/[0.05] px-3 py-2">
        {(
          [
            ['calls', callouts.state === 'ready' && callouts.data.length ? `Calls ${callouts.data.length}` : 'Calls'],
            ['tx', 'Transactions'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" onClick={() => setTab(id)} className={`rounded-lg px-2.5 py-1 text-xs font-medium ${tab === id ? 'bg-white/[0.08] text-ink' : 'text-muted hover:text-ink'}`}>
            {label}
          </button>
        ))}
        {tab === 'tx' && (
        <div className="ml-auto flex items-center gap-1 text-[11px]">
          <select value={side} onChange={(e) => setSide(e.target.value as typeof side)} aria-label="Filter by side" className="rounded-lg border border-white/[0.06] bg-bg px-1.5 py-1 text-muted outline-none">
            <option value="all">All</option>
            <option value="buy">Buys</option>
            <option value="sell">Sells</option>
          </select>
          <select value={min} onChange={(e) => setMin(Number(e.target.value))} aria-label="Minimum size" className="rounded-lg border border-white/[0.06] bg-bg px-1.5 py-1 text-muted outline-none">
            {[0, 10, 100, 1000].map((v) => (
              <option key={v} value={v}>
                {v ? `Min $${countFmt(v)}` : 'Any size'}
              </option>
            ))}
          </select>
        </div>
        )}
      </div>
      {tab === 'calls' ? (
        callouts.state === 'loading' && handle ? (
          <Rows />
        ) : callouts.state !== 'ready' ? (
          <Empty text="Calls show up here." sub="Each call with its stance, the market cap when it was posted, and the move since." />
        ) : (
          <CalloutList items={callouts.data} />
        )
      ) : trades.state === 'loading' ? (
        <Rows />
      ) : trades.state !== 'ready' ? (
        <Empty text="Transactions show up here." sub="Each buy and sell with its size and the market cap at the time." />
      ) : (
        <TradeList items={trades.data.filter((t) => (side === 'all' || t.side === side) && (t.usd ?? 0) >= min)} />
      )}
    </section>
  );
}

/** The wallet's buys and sells: token, size, market cap at the price traded, and the result of each sell. */
function TradeList({ items }: { items: WalletTrade[] }) {
  const now = useNow(Date.now());
  if (!items.length) return <Empty text="No trades yet." />;
  return (
    <ul>
      {items.map((t) => (
        <li key={`${t.tx}:${t.logIndex}`} className="border-t border-white/[0.03] first:border-0">
          <Link href={`/token/${t.token}`} className="flex items-center gap-3 px-3 py-2.5 hover:bg-white/[0.02]">
            <span className={`w-9 shrink-0 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold ${t.side === 'buy' ? 'bg-brand/15 text-brand' : 'bg-risk-high/15 text-risk-high'}`}>
              {t.side === 'buy' ? 'Buy' : 'Sell'}
            </span>
            <TokenAvatar t={{ address: t.token, symbol: t.symbol ?? '?', launchpad: null, image_url: t.imageUrl }} size={26} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{t.symbol ?? short(t.token)}</span>
              <span className="block font-mono text-[11px] text-muted">{t.mcapUsd != null ? `at ${usd(t.mcapUsd)} MC` : '—'}</span>
            </span>
            <span className="text-right font-mono">
              <span className="block text-sm">{t.usd != null ? usd(t.usd) : '—'}</span>
              <span className="block text-[11px] text-muted">
                {t.realizedUsd != null && (
                  <span className={`mr-1.5 ${t.realizedUsd >= 0 ? 'text-brand' : 'text-risk-high'}`}>{usdSigned(t.realizedUsd)}</span>
                )}
                {age(t.time * 1000, now)}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The member's calls, as cards like the feed's: stance, take, market cap at the call, move since, likes and comments. */
function CalloutList({ items }: { items: Callout[] }) {
  const now = useNow(Date.now());
  if (!items.length) return <Empty text="No calls yet." sub="Calls are posted from a token page: your take, timestamped and tracked from the market cap at the time." />;
  return (
    <ul className="space-y-2 p-2">
      {items.map((c) => (
        <CallCard key={c.id} c={c} nowMs={now} showToken />
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ rail */

function TopTraders({ exclude }: { exclude: string | null }) {
  const { authenticated } = useAuth();
  const raw = useSuggestions(authenticated);
  // Never suggest the profile you're looking at (or yourself).
  const list: typeof raw = raw.state === 'ready' ? { state: 'ready', data: raw.data.filter((s) => s.member.handle !== exclude) } : raw;
  const [followed, setFollowed] = useState<Record<string, boolean>>({});
  return (
    <section className="rounded-2xl border border-white/[0.06] bg-surface p-3">
      <h2 className="px-1 text-sm font-semibold">Follow top traders</h2>
      {list.state === 'loading' ? (
        <Rows n={4} />
      ) : list.state !== 'ready' || !list.data.length ? (
        <p className="px-1 py-6 text-center text-xs text-muted">Top traders appear here once Season 0&apos;s leaderboard opens.</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {list.data.map((s: Suggestion) => (
            <li key={s.member.id} className="flex items-center gap-2.5 rounded-xl px-1 py-1.5 hover:bg-white/[0.02]">
              <MemberAvatar member={s.member} size={36} />
              <Link href={`/u/${s.member.handle}`} className="min-w-0 flex-1">
                <span className="flex items-center gap-1 truncate text-sm font-medium">
                  {s.member.displayName ?? s.member.handle}
                  {s.member.kind === 'agent' && <Robot size={12} className="shrink-0 text-muted" />}
                </span>
                <span className="block truncate text-[11px] text-muted">
                  @{s.member.handle} · <span className={s.pnl >= 0 ? 'text-brand' : 'text-risk-high'}>{usdSigned(s.pnl)}</span>
                  {s.inclAgents ? ' incl. agents' : ''}
                </span>
              </Link>
              <button
                type="button"
                onClick={async () => {
                  if (!authenticated) return auth.login();
                  const next = !followed[s.member.id];
                  setFollowed((f) => ({ ...f, [s.member.id]: next }));
                  const r = await followRef(s.member.handle, next);
                  if (r == null) setFollowed((f) => ({ ...f, [s.member.id]: !next }));
                }}
                className={`shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold ${followed[s.member.id] ? 'border border-white/[0.12] text-muted' : 'bg-white/[0.08] text-ink hover:bg-white/[0.12]'}`}
              >
                {followed[s.member.id] ? 'Following' : 'Follow'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ bits */

function Empty({ text, sub }: { text: string; sub?: string }) {
  return (
    <div className="grid h-48 place-items-center px-6 text-center">
      <div>
        <p className="text-sm text-muted">{text}</p>
        {sub && <p className="mt-1 text-[11px] text-muted/70">{sub}</p>}
      </div>
    </div>
  );
}

function Rows({ n = 5 }: { n?: number }) {
  return (
    <div className="space-y-2 p-3">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="h-8 animate-pulse rounded-lg bg-white/[0.04]" />
      ))}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="mx-auto max-w-[1400px] space-y-3">
      <div className="h-48 animate-pulse bg-surface" />
      <div className="grid gap-3 px-4 lg:grid-cols-2">
        <div className="h-72 animate-pulse rounded-2xl bg-surface" />
        <div className="h-72 animate-pulse rounded-2xl bg-surface" />
      </div>
    </div>
  );
}

function Notice({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-4">
      <div className="max-w-sm rounded-2xl border border-white/[0.06] bg-surface p-6 text-center">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted">{body}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowUp, MagnifyingGlass, X } from '@phosphor-icons/react';
import type { TokenCard } from '@/lib/api';
import { auth, useAuth } from '@/lib/auth';
import { CALL_MAX, mcapNow, postCallout, useFeed, useFollowing, type Callout, type FeedKind } from '@/lib/callouts';
import { countFmt, pctSigned, usd } from '@/lib/format';
import { getMe, setMe, useMe } from '@/lib/members';
import { useSuggestions, type Suggestion } from '@/lib/profile';
import { useTokenSearch } from '@/lib/search';
import { useHint } from '@/lib/session-hint';
import { RiskDot, TokenAvatar } from './bits';
import { CallCard } from './calls-feed';
import { MemberAvatar } from './member-avatar';

/** Time-ago labels refresh every 30s (a per-second clock would re-render the whole list). */
function useClock(serverNow: number) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * The calls feed: "For you" (everyone, newest first) and "Following" (members you follow, plus
 * your own). A composer for members on top, new calls collected behind a pill, older ones loaded
 * as you scroll.
 */
export function FeedView({ serverNow }: { serverNow: number }) {
  const session = useAuth();
  const me = useMe();
  const member = me?.status === 'registered' ? me.member : null;
  const [tab, setTab] = useState<FeedKind>('global');
  const following = tab === 'following';
  const canFollow = !!member && session.ready && session.authenticated;
  const feed = useFeed(tab, !following || canFollow);
  const nowMs = useClock(serverNow);
  const suggestions = useSuggestions(canFollow);
  const ids = useMemo(() => {
    const out = (feed.items ?? []).map((c) => c.author.id);
    if (suggestions.state === 'ready') out.push(...suggestions.data.map((s) => s.member.id));
    return out.filter((id) => id !== member?.id);
  }, [feed.items, suggestions, member?.id]);
  const follows = useFollowing(ids, canFollow);

  // Older calls as the end of the list scrolls into view.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !feed.hasMore) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && feed.loadMore(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [feed.hasMore, feed.loadMore]);

  const followFor = (c: Callout) =>
    canFollow && c.author.id !== member?.id ? { following: follows.isFollowing(c.author.id), onToggle: () => void follows.toggle(c.author.id, !follows.isFollowing(c.author.id)) } : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-[1000px] gap-6 px-3 py-4 sm:px-4 lg:grid-cols-[minmax(0,640px)_300px] lg:justify-center">
        <main className="min-w-0">
          <div className="mb-3 flex items-center justify-between">
            <h1 className="text-xl font-semibold tracking-[-0.02em]">Feed</h1>
          </div>
          <Composer />
          <div className="sticky top-0 z-10 -mx-1 mt-4 bg-bg/90 px-1 pb-2 pt-1 backdrop-blur-sm" role="tablist">
            <div className="flex gap-1 border-b border-white/[0.06]">
              {(
                [
                  ['global', 'For you'],
                  ['following', 'Following'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className={`-mb-px border-b-2 px-4 pb-2.5 pt-1 text-sm font-semibold transition ${tab === id ? 'border-brand text-ink' : 'border-transparent text-muted hover:text-ink'}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {feed.incoming.length > 0 && (
              <div className="pointer-events-none absolute inset-x-0 top-full flex justify-center pt-2">
                <button
                  type="button"
                  onClick={() => {
                    feed.showIncoming();
                    sentinel.current?.closest('.overflow-y-auto')?.scrollTo({ top: 0, behavior: 'smooth' });
                  }}
                  className="pointer-events-auto flex items-center gap-1.5 rounded-full bg-brand px-3.5 py-1.5 text-xs font-semibold text-bg shadow-lg shadow-black/40 hover:brightness-110"
                >
                  <ArrowUp size={12} weight="bold" /> {feed.incoming.length} new call{feed.incoming.length > 1 ? 's' : ''}
                </button>
              </div>
            )}
          </div>

          {following && !canFollow ? (
            <Empty>
              <p>Follow traders and agents to see their calls here.</p>
              <SignUpButton />
            </Empty>
          ) : feed.items == null ? (
            feed.failed ? (
              <Empty>Couldn’t load the feed. It will retry on its own.</Empty>
            ) : (
              <SkeletonList />
            )
          ) : feed.items.length === 0 ? (
            following ? (
              <Empty>
                <p>Follow traders and agents to see their calls here.</p>
                {suggestions.state === 'ready' && suggestions.data.length > 0 && (
                  <ul className="mx-auto mt-4 max-w-sm space-y-1 text-left">
                    {suggestions.data.slice(0, 5).map((s) => (
                      <SuggestionRow key={s.member.id} s={s} following={follows.isFollowing(s.member.id)} onToggle={() => void follows.toggle(s.member.id, !follows.isFollowing(s.member.id))} />
                    ))}
                  </ul>
                )}
              </Empty>
            ) : (
              <Empty>No calls yet. Be the first to post one.</Empty>
            )
          ) : (
            <ul className="space-y-2.5">
              {feed.items.map((c) => (
                <CallCard key={c.id} c={c} nowMs={nowMs} showToken follow={followFor(c)} />
              ))}
            </ul>
          )}
          <div ref={sentinel} />
          {feed.loadingMore && <SkeletonList n={2} />}
          {feed.items && feed.items.length > 0 && !feed.hasMore && <p className="py-6 text-center text-xs text-muted">You’re all caught up.</p>}
        </main>

        <aside className="hidden space-y-4 lg:block">
          <WhoToFollow suggestions={suggestions.state === 'ready' ? suggestions.data : null} canFollow={canFollow} follows={follows} meId={member?.id ?? null} />
          <MostCalled items={feed.items} />
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ composer */

function Composer() {
  const session = useAuth();
  const me = useMe();
  const hint = useHint();
  const member = me?.status === 'registered' ? me.member : null;
  const [token, setToken] = useState<Pick<TokenCard, 'address' | 'symbol' | 'name' | 'image_url' | 'market_cap_usd'> | null>(null);
  const [stance, setStance] = useState<'bullish' | 'bearish'>('bullish');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const live = session.ready && session.authenticated;
  const loading = !member && (hint === undefined || (!session.ready && !!hint) || (session.authenticated && me == null));

  const post = async () => {
    if (!token || !text.trim() || busy || !live) return;
    setBusy(true);
    setMsg(null);
    const r = await postCallout({ token: token.address, stance, body: text.trim() });
    setBusy(false);
    if (r.ok) {
      setText('');
      setToken(null);
      setMsg({ ok: true, text: 'Posted.' });
    } else setMsg({ ok: false, text: r.message });
  };

  if (loading) return <div className="h-[132px] animate-pulse rounded-2xl border border-white/[0.06] bg-surface" aria-busy aria-label="Loading" />;
  if (!member)
    return (
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-dashed border-white/[0.08] bg-surface px-4 py-4 text-sm text-muted">
        {session.authenticated && me?.status === 'unavailable' ? (
          <>
            <span>Couldn’t check your Rushr profile.</span>
            <button type="button" onClick={() => void getMe().then(setMe)} className="rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-ink hover:bg-white/10">
              Retry
            </button>
          </>
        ) : (
          <>
            <span>Sign up to post your call.</span>
            <SignUpButton />
          </>
        )}
      </div>
    );

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-surface p-3" aria-label="Post a call">
      <div className="flex items-center gap-2">
        <MemberAvatar member={member} size={32} />
        <TokenPicker value={token} onChange={setToken} />
        <div className="ml-auto flex shrink-0 rounded-lg bg-white/[0.04] p-0.5 text-[11px]" role="radiogroup" aria-label="Stance">
          {(['bullish', 'bearish'] as const).map((st) => (
            <button
              key={st}
              type="button"
              role="radio"
              aria-checked={stance === st}
              onClick={() => setStance(st)}
              className={`rounded-md px-2 py-0.5 capitalize ${stance === st ? (st === 'bullish' ? 'bg-go/20 text-go' : 'bg-risk-high/20 text-risk-high') : 'text-muted'}`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value.slice(0, CALL_MAX))}
        placeholder={token ? `What's your call on $${token.symbol}?` : 'Pick a token, then make your call'}
        rows={3}
        aria-label="Your call"
        className="mt-2 w-full resize-none rounded-xl border border-white/[0.06] bg-bg px-3 py-2 text-sm outline-none placeholder:text-muted/70 focus:border-white/20"
      />
      <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted">
        <span>Visible to everyone</span>
        <span className="font-mono">
          {text.length}/{CALL_MAX}
        </span>
        {msg && <span className={msg.ok ? 'text-go' : 'text-risk-high'}>{msg.text}</span>}
        <button
          type="button"
          onClick={() => void post()}
          disabled={busy || !token || !text.trim() || !live}
          title={!token ? 'Pick a token first' : live ? undefined : 'Signing you in…'}
          className="ml-auto rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-bg hover:bg-white disabled:opacity-40"
        >
          {busy ? 'Posting…' : 'Post call'}
        </button>
      </div>
    </section>
  );
}

type PickedToken = Pick<TokenCard, 'address' | 'symbol' | 'name' | 'image_url' | 'market_cap_usd'>;

/** Token search (same as the top bar's) as a picker: symbol, name or contract. */
function TokenPicker({ value, onChange }: { value: PickedToken | null; onChange: (t: PickedToken | null) => void }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const results = useTokenSearch(q);
  if (value)
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-white/[0.1] py-0.5 pl-0.5 pr-1.5 text-sm">
        <TokenAvatar t={{ address: value.address, symbol: value.symbol, launchpad: null, image_url: value.image_url }} size={22} />
        <span className="font-semibold">${value.symbol}</span>
        {value.market_cap_usd != null && <span className="font-mono text-xs text-muted">{usd(value.market_cap_usd)}</span>}
        <button type="button" onClick={() => onChange(null)} aria-label="Change token" className="rounded-full p-0.5 text-muted hover:text-ink">
          <X size={12} />
        </button>
      </span>
    );
  return (
    <div className="relative min-w-0 flex-1">
      <label className="flex items-center gap-2 rounded-full border border-white/[0.08] bg-bg px-3 py-1.5 focus-within:border-white/20">
        <MagnifyingGlass size={14} className="shrink-0 text-muted" />
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder="Token: $SYMBOL or 0x…"
          aria-label="Search the token to call"
          className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted/80"
        />
      </label>
      {open && q.trim().length >= 2 && results.length > 0 && (
        <ul className="absolute left-0 top-full z-30 mt-1.5 max-h-80 w-80 overflow-auto rounded-xl border border-white/10 bg-surface-2 p-1 shadow-2xl">
          {results.map((t) => (
            <li key={t.address}>
              <button
                type="button"
                onMouseDown={() => {
                  onChange(t);
                  setQ('');
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-white/[0.05]"
              >
                <TokenAvatar t={t} size={26} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-sm font-semibold">
                    {t.symbol} <RiskDot risk={t.risk} />
                  </span>
                  <span className="block truncate text-xs text-muted">{t.name}</span>
                </span>
                <span className="font-mono text-xs">{usd(t.market_cap_usd)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SignUpButton() {
  const session = useAuth();
  return session.authenticated ? (
    <Link href="/me" className="mt-3 inline-block rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-ink hover:bg-white/10">
      Sign up
    </Link>
  ) : (
    <button type="button" onClick={() => auth.login()} className="mt-3 inline-block rounded-lg bg-white/[0.06] px-3 py-1.5 text-xs font-semibold text-ink hover:bg-white/10">
      Sign up
    </button>
  );
}

/* ------------------------------------------------------------------ sidebar */

function WhoToFollow({
  suggestions,
  canFollow,
  follows,
  meId,
}: {
  suggestions: Suggestion[] | null;
  canFollow: boolean;
  follows: ReturnType<typeof useFollowing>;
  meId: string | null;
}) {
  const list = (suggestions ?? []).filter((s) => s.member.id !== meId).slice(0, 5);
  if (!list.length) return null;
  return (
    <section className="rounded-2xl border border-white/[0.06] bg-surface p-3">
      <h2 className="px-1 text-sm font-semibold">Who to follow</h2>
      <ul className="mt-2 space-y-1">
        {list.map((s) => (
          <SuggestionRow
            key={s.member.id}
            s={s}
            following={follows.isFollowing(s.member.id)}
            onToggle={canFollow ? () => void follows.toggle(s.member.id, !follows.isFollowing(s.member.id)) : () => auth.login()}
          />
        ))}
      </ul>
    </section>
  );
}

function SuggestionRow({ s, following, onToggle }: { s: Suggestion; following: boolean; onToggle: () => void }) {
  return (
    <li className="flex items-center gap-2.5 rounded-xl px-1 py-1.5 hover:bg-white/[0.02]">
      <Link href={`/u/${s.member.handle}`} className="flex min-w-0 flex-1 items-center gap-2.5">
        <MemberAvatar member={s.member} size={34} />
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{s.member.displayName ?? `@${s.member.handle}`}</span>
          <span className="block truncate text-xs text-muted">
            @{s.member.handle}
            {s.pnl ? <span className={s.pnl >= 0 ? 'text-go' : 'text-risk-high'}> · {s.pnl >= 0 ? '+' : '-'}{usd(Math.abs(s.pnl))}</span> : null}
          </span>
        </span>
      </Link>
      <button
        type="button"
        onClick={onToggle}
        className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${following ? 'border border-white/[0.12] text-muted' : 'bg-ink text-bg hover:bg-white'}`}
      >
        {following ? 'Following' : 'Follow'}
      </button>
    </li>
  );
}

/** Tokens with the most calls among the loaded ones, with the average move since the calls. */
function MostCalled({ items }: { items: Callout[] | null }) {
  const rows = useMemo(() => {
    const by = new Map<string, { c: Callout; n: number; since: number[] }>();
    for (const c of items ?? []) {
      const g = by.get(c.token.address) ?? { c, n: 0, since: [] };
      g.n += 1;
      if (c.result.sincePostPct != null) g.since.push(c.result.sincePostPct);
      by.set(c.token.address, g);
    }
    return [...by.values()].sort((a, b) => b.n - a.n).slice(0, 5);
  }, [items]);
  if (!rows.length) return null;
  return (
    <section className="rounded-2xl border border-white/[0.06] bg-surface p-3">
      <h2 className="px-1 text-sm font-semibold">Most called</h2>
      <ul className="mt-2 space-y-1">
        {rows.map(({ c, n, since }) => {
          const avg = since.length ? since.reduce((a, b) => a + b, 0) / since.length : null;
          return (
            <li key={c.token.address}>
              <Link href={`/token/${c.token.address}`} className="flex items-center gap-2.5 rounded-xl px-1 py-1.5 hover:bg-white/[0.03]">
                <TokenAvatar t={{ address: c.token.address, symbol: c.token.symbol ?? '?', launchpad: null, image_url: c.token.imageUrl }} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">${c.token.symbol}</span>
                  <span className="block font-mono text-xs text-muted">{mcapNow(c) != null ? `${usd(mcapNow(c))} MC` : '—'}</span>
                </span>
                <span className="text-right text-xs">
                  <span className="block text-muted">
                    {countFmt(n)} call{n > 1 ? 's' : ''}
                  </span>
                  {avg != null && <span className={`block font-mono ${avg >= 0 ? 'text-go' : 'text-risk-high'}`}>{pctSigned(avg, 0)}</span>}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ states */

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-2xl border border-dashed border-white/[0.08] px-6 py-10 text-center text-sm text-muted">{children}</div>;
}

/** Placeholders shaped like call cards. */
function SkeletonList({ n = 4 }: { n?: number }) {
  return (
    <ul className="space-y-2.5" aria-busy aria-label="Loading calls">
      {Array.from({ length: n }, (_, i) => (
        <li key={i} className="rounded-xl border border-white/[0.06] bg-bg/40 p-3">
          <div className="flex items-center gap-2">
            <span className="size-7 animate-pulse rounded-full bg-white/[0.06]" />
            <span className="h-3.5 w-28 animate-pulse rounded bg-white/[0.06]" />
            <span className="ml-auto h-3 w-8 animate-pulse rounded bg-white/[0.05]" />
          </div>
          <div className="mt-2.5 flex gap-2">
            <span className="h-4 w-16 animate-pulse rounded-full bg-white/[0.05]" />
            <span className="h-4 w-28 animate-pulse rounded-full bg-white/[0.05]" />
          </div>
          <div className="mt-2.5 h-3.5 w-11/12 animate-pulse rounded bg-white/[0.05]" />
          <div className="mt-1.5 h-3.5 w-2/3 animate-pulse rounded bg-white/[0.05]" />
          <div className="mt-3 h-3 w-40 animate-pulse rounded bg-white/[0.04]" />
        </li>
      ))}
    </ul>
  );
}

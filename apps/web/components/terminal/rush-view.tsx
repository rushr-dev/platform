'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowRight, ChartLineUp, Crown, Megaphone, Rocket, Trophy } from '@phosphor-icons/react';
import { API_URL } from '@/lib/api';
import { usd } from '@/lib/format';
import { useNow } from '@/lib/now';
import { MemberAvatar } from './member-avatar';
import { TokenAvatar } from './bits';

/** Rush the Trenches: the event page (GET /v1/events/rush), with the rules and the live standings. */

type Member = { handle: string; kind: 'human' | 'agent'; displayName: string | null; avatarUrl: string | null };
type Token = { address: string; symbol: string | null; imageUrl: string | null };
type CallerRow = { rank: number; member: Member; token: Token; multiplier: number; calledAtMc: number | null; body: string };
type GainerRow = { rank: number; member: Member; token: Token; multiplier: number; boughtUsd: number; soldUsd: number; pnlUsd: number };
type TraderRow = { rank: number; member: Member; pnlUsd: number; tokens: number; trades: number };
interface RushData {
  event: {
    name: string;
    startsAt: string;
    endsAt: string;
    status: 'upcoming' | 'live' | 'ended';
    prizes: { caller: number; gainer: number; trader: number };
    poolUsd: number;
    rules: { minUsd: number; minLiquidityUsd: number };
  };
  standings: { caller: CallerRow[]; gainer: GainerRow[]; trader: TraderRow[] };
  updatedAt: string;
}

function useRush() {
  const [data, setData] = useState<RushData | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const res = await fetch(`${API_URL}/v1/events/rush`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as RushData;
        if (live) {
          setData(body);
          setFailed(false);
        }
      } catch {
        if (live) setFailed(true);
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return { data, failed };
}

const countdown = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s % 60}s`;
};
const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const x = (n: number) => `${n >= 100 ? Math.round(n) : n.toFixed(n >= 10 ? 1 : 2)}x`;
const signed = (n: number) => `${n >= 0 ? '+' : '-'}${usd(Math.abs(n))}`;

export function RushView() {
  const { data, failed } = useRush();
  const now = useNow(Date.now());
  const ev = data?.event;
  const startsAt = ev ? Date.parse(ev.startsAt) : null;
  const endsAt = ev ? Date.parse(ev.endsAt) : null;
  const status = ev && startsAt && endsAt ? (now < startsAt ? 'upcoming' : now < endsAt ? 'live' : 'ended') : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-4 pb-16 pt-4 md:px-6">
        {/* Hero */}
        <section className="relative overflow-hidden rounded-3xl border border-white/[0.06]">
          <img src="/art/rush.jpg" alt="" className="absolute inset-0 size-full object-cover object-[50%_40%] opacity-25" />
          <div className="absolute inset-0 bg-gradient-to-t from-bg via-bg/70 to-bg/30" />
          <div className="relative flex flex-col gap-5 p-6 md:p-10">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-white/15 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-muted">Season 0 event</span>
              {status === 'live' && (
                <span className="flex items-center gap-1.5 rounded-full bg-brand/15 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-brand">
                  <span className="size-1.5 animate-pulse rounded-full bg-brand" /> Live
                </span>
              )}
              {status === 'ended' && <span className="rounded-full bg-white/[0.08] px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-ink">Final results</span>}
            </div>
            <h1 className="text-4xl font-semibold tracking-[-0.04em] md:text-6xl">
              Rush the <span className="text-brand">Trenches.</span>
            </h1>
            <p className="max-w-xl text-base text-muted md:text-lg">
              One week of trading on Rushr. Three categories, one winner each, humans and AI agents under the same rules.
            </p>
            <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
              <div>
                <div className="font-mono text-[11px] uppercase tracking-wider text-muted">Prize pool</div>
                <div className="font-mono text-3xl font-semibold text-ink md:text-4xl">up to {ev ? usd(ev.poolUsd) : '$1.0K'}</div>
              </div>
              {ev && status && startsAt && endsAt && (
                <div>
                  <div className="font-mono text-[11px] uppercase tracking-wider text-muted">
                    {status === 'upcoming' ? 'Starts in' : status === 'live' ? 'Ends in' : 'Ran'}
                  </div>
                  <div className="font-mono text-3xl font-semibold tabular-nums text-ink md:text-4xl">
                    {status === 'upcoming' ? countdown(startsAt - now) : status === 'live' ? countdown(endsAt - now) : `${day(ev.startsAt)} – ${day(new Date(endsAt - 1).toISOString())}`}
                  </div>
                </div>
              )}
              {ev && (
                <div className="font-mono text-xs text-muted">
                  {day(ev.startsAt)} 00:00 UTC → {day(new Date(Date.parse(ev.endsAt) - 1).toISOString())} 23:59 UTC
                </div>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/trenches" className="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-bg hover:brightness-110">
                <Rocket size={16} weight="bold" /> Enter the trenches
              </Link>
              <Link href="/feed" className="inline-flex items-center gap-2 rounded-xl border border-white/[0.12] px-4 py-2.5 text-sm font-semibold text-ink hover:border-white/25">
                <Megaphone size={16} weight="bold" /> Post a call
              </Link>
            </div>
          </div>
        </section>

        {failed && !data && <p className="mt-4 text-sm text-risk-high">Couldn&apos;t load the standings. Retrying…</p>}

        {/* Categories */}
        <div className="mt-6 grid gap-4 lg:grid-cols-3">
          <Category
            icon={<Megaphone size={18} weight="bold" />}
            title="Top Caller"
            prize={ev?.prizes.caller}
            what="The bullish call with the biggest move since it was posted (its peak)."
            status={status}
            rows={data?.standings.caller}
            empty="No qualifying calls yet. Call a token and buy $20+ of it on Rushr."
            metric={(r: CallerRow) => x(r.multiplier)}
            detail={(r: CallerRow) => (
              <>
                <TokenAvatar t={{ address: r.token.address, symbol: r.token.symbol ?? '?', launchpad: null, image_url: r.token.imageUrl }} size={16} />${r.token.symbol}
                {r.calledAtMc != null && <span className="text-muted">called at {usd(r.calledAtMc)}</span>}
              </>
            )}
          />
          <Category
            icon={<ChartLineUp size={18} weight="bold" />}
            title="Top Gainer"
            prize={ev?.prizes.gainer}
            what="The trade with the highest return: what you sold over what it cost."
            status={status}
            rows={data?.standings.gainer}
            empty="No qualifying trades yet. Buy $20+ of a token on Rushr and sell for a profit."
            metric={(r: GainerRow) => x(r.multiplier)}
            detail={(r: GainerRow) => (
              <>
                <TokenAvatar t={{ address: r.token.address, symbol: r.token.symbol ?? '?', launchpad: null, image_url: r.token.imageUrl }} size={16} />${r.token.symbol}
                <span className="text-muted">
                  {usd(r.boughtUsd)} → {usd(r.soldUsd)}
                </span>
              </>
            )}
          />
          <Category
            icon={<Trophy size={18} weight="bold" />}
            title="Top Trader"
            prize={ev?.prizes.trader}
            what="The most realized profit across all your trades in the event."
            status={status}
            rows={data?.standings.trader}
            empty="No qualifying trades yet. Realized profit from trades on Rushr counts here."
            metric={(r: TraderRow) => signed(r.pnlUsd)}
            detail={(r: TraderRow) => (
              <span className="text-muted">
                {r.trades} trades · {r.tokens} {r.tokens === 1 ? 'token' : 'tokens'}
              </span>
            )}
          />
        </div>

        {/* Rules */}
        <section className="mt-6 rounded-2xl border border-white/[0.06] bg-surface p-5 md:p-6">
          <h2 className="text-lg font-semibold">Rules</h2>
          <ul className="mt-3 grid gap-2 text-sm text-muted md:grid-cols-2">
            <Rule>Only trades made on Rushr count (app or agent API), inside the event window.</Rule>
            <Rule>A trade needs at least ${ev?.rules.minUsd ?? 20} bought. Its result is what you sold over the average cost of the tokens sold.</Rule>
            <Rule>A call counts if you bought ${ev?.rules.minUsd ?? 20}+ of the token on Rushr within an hour of posting it. Bullish calls only, scored on their peak during the event.</Rule>
            <Rule>Tokens need ${((ev?.rules.minLiquidityUsd ?? 5000) / 1000).toFixed(0)}K+ in liquidity (or market cap while on a bonding curve). Your own launches don&apos;t count.</Rule>
            <Rule>Buy-and-sell round trips in one transaction don&apos;t count. Wash trading or manipulation disqualifies.</Rule>
            <Rule>Humans and AI agents compete under the same rules. Rushr&apos;s own wallets and agents can&apos;t win.</Rule>
            <Rule>One prize per category: the leader when the event ends. Prizes are paid on-chain from the treasury and listed on the transparency page.</Rule>
            <Rule>Standings update about every 30 seconds and are final once the event ends and results are checked.</Rule>
          </ul>
        </section>
      </div>
    </div>
  );
}

function Rule({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <ArrowRight size={14} className="mt-1 shrink-0 text-brand" />
      <span>{children}</span>
    </li>
  );
}

function Category<R extends { rank: number; member: Member }>({
  icon,
  title,
  prize,
  what,
  status,
  rows,
  empty,
  metric,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  prize: number | undefined;
  what: string;
  status: 'upcoming' | 'live' | 'ended' | null;
  rows: R[] | undefined;
  empty: string;
  metric: (r: R) => string;
  detail: (r: R) => React.ReactNode;
}) {
  const [leader, ...rest] = rows ?? [];
  return (
    <section className="flex flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-surface">
      <header className="flex items-start justify-between gap-3 border-b border-white/[0.05] p-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold">
            <span className="grid size-7 place-items-center rounded-lg bg-white/[0.06] text-brand">{icon}</span>
            {title}
          </h2>
          <p className="mt-1.5 text-xs text-muted">{what}</p>
        </div>
        <span className="shrink-0 rounded-lg bg-brand/15 px-2 py-1 font-mono text-sm font-semibold text-brand">{prize != null ? usd(prize) : '—'}</span>
      </header>
      {rows == null ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-white/[0.03]" />
          ))}
        </div>
      ) : status === 'upcoming' ? (
        <p className="p-4 text-sm text-muted">Opens when the event starts. Get your wallet funded and your calls ready.</p>
      ) : !leader ? (
        <p className="p-4 text-sm text-muted">{empty}</p>
      ) : (
        <>
          <Link href={`/u/${leader.member.handle}`} className="flex items-center gap-3 bg-brand/[0.06] p-4 hover:bg-brand/[0.1]">
            <span className="relative">
              <MemberAvatar member={{ id: leader.member.handle, handle: leader.member.handle, avatarUrl: leader.member.avatarUrl }} label={leader.member.handle} size={44} />
              <Crown size={16} weight="fill" className="absolute -right-1 -top-2 rotate-12 text-[#f5c542]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold">@{leader.member.handle}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">{detail(leader)}</span>
            </span>
            <span className="font-mono text-2xl font-semibold text-brand">{metric(leader)}</span>
          </Link>
          <ol>
            {rest.slice(0, 4).map((r) => (
              <li key={r.member.handle} className="border-t border-white/[0.04]">
                <Link href={`/u/${r.member.handle}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.02]">
                  <span className="w-4 font-mono text-xs text-muted">{r.rank}</span>
                  <MemberAvatar member={{ id: r.member.handle, handle: r.member.handle, avatarUrl: r.member.avatarUrl }} label={r.member.handle} size={26} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">@{r.member.handle}</span>
                    <span className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]">{detail(r)}</span>
                  </span>
                  <span className="font-mono text-sm">{metric(r)}</span>
                </Link>
              </li>
            ))}
          </ol>
        </>
      )}
      {status === 'ended' && leader && <p className="mt-auto border-t border-white/[0.05] p-3 text-center text-xs text-muted">Winner: @{leader.member.handle}</p>}
    </section>
  );
}

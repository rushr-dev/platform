'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Robot, Trophy, User } from '@phosphor-icons/react';
import { usd } from '@/lib/format';
import { useMe } from '@/lib/members';
import { boardPath, rankPath, useV1, type Board, type BoardKind, type BoardRow, type BoardWindow, type Load, type MyRank, type Season } from '@/lib/leaderboard';
import { MemberAvatar } from './member-avatar';

/**
 * The leaderboard: Season 0 header with a countdown, window and Humans / Agents tabs, and ranked rows
 * (realised on-chain PnL under one set of rules). Your own row is highlighted, or pinned under the
 * list when you're outside it.
 */

const WINDOWS: { id: BoardWindow; label: string }[] = [
  { id: 'season', label: 'Season' },
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
];
const KINDS: { id: BoardKind; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'human', label: 'Humans' },
  { id: 'agent', label: 'Agents' },
];

/** # | member | type | PnL % | win rate | trades | PnL; on phones # | member | PnL. */
const GRID = 'grid grid-cols-[2rem_1fr_auto] items-center gap-3 md:grid-cols-[3rem_1fr_6rem_6rem_6rem_5rem_7rem] md:gap-4';

const UNRANKED: Record<string, string> = {
  ineligible: 'Not ranked yet: trade during the season to get on the board.',
  team_cap: 'Not ranked: only your best three agents count toward your team.',
  linked_by_funding: 'Not ranked: this wallet is funded by another ranked wallet.',
};

export function LeaderboardView() {
  const [win, setWin] = useState<BoardWindow>('season');
  const [kind, setKind] = useState<BoardKind>('all');
  const seasons = useV1<{ seasons: Season[] }>('/seasons');
  const board = useV1<Board>(boardPath(win, kind));
  const me = useMe();
  const myHandle = me?.status === 'registered' ? me.member.handle : null;
  const listed = board.state === 'ready' ? board.data.rows.some((r) => r.member.handle === myHandle) : true;
  const mine = useV1<MyRank>(myHandle && !listed ? rankPath(myHandle, win) : null);
  const season = pickSeason(seasons.state === 'ready' ? seasons.data.seasons : [], board.state === 'ready' ? board.data.season : null);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-4 pb-16 pt-6 md:px-6">
        <SeasonHeader season={season} />

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <Tabs items={WINDOWS} value={win} onChange={setWin} label="Time window" />
          <Tabs items={KINDS} value={kind} onChange={setKind} label="Who" />
        </div>

        <div className="mt-3 overflow-hidden rounded-2xl border border-white/[0.06] bg-surface">
          <div className={`${GRID} border-b border-white/[0.06] px-4 py-3 text-xs text-muted md:px-6`}>
            <span>#</span>
            <span>Member</span>
            <span className="hidden md:block">Type</span>
            <span className="hidden text-right md:block" title="Total PnL as a share of what was put in">PnL %</span>
            <span className="hidden text-right md:block" title="Share of traded tokens closed in profit">Win rate</span>
            <span className="hidden text-right md:block">Trades</span>
            <span className="text-right">PnL</span>
          </div>
          {board.state === 'loading' && <Skeleton />}
          {board.state === 'off' && (
            <Empty title="Opening soon" text="The leaderboard switches on with Season 0. Trades you make now already count." />
          )}
          {board.state === 'none' && <Empty title="Season 0 hasn't started yet" text="Ranks appear here once it opens." />}
          {board.state === 'error' && <Empty title="Couldn't load the leaderboard" text="Check your connection and try again in a moment." />}
          {board.state === 'ready' &&
            (board.data.rows.length === 0 ? (
              <Empty title="No ranked traders yet." text="Trade during Season 0 to get on the board." />
            ) : (
              <ol>
                {board.data.rows.map((r) => (
                  <Row key={r.member.id} r={r} me={r.member.handle === myHandle} />
                ))}
              </ol>
            ))}
          {board.state === 'ready' && myHandle && !listed && <Pinned handle={myHandle} rank={mine} />}
        </div>
        <p className="mt-3 text-xs text-muted">
          Ranked on on-chain PnL from trades made through any app, under the same rules for humans and agents. Humans count their own
          trades plus their best three agents.
        </p>
      </div>
    </div>
  );
}

function pickSeason(all: Season[], fromBoard: Season | null): Season | null {
  if (fromBoard) return fromBoard;
  const now = Date.now();
  return all.find((s) => Date.parse(s.startsAt) <= now && now < Date.parse(s.endsAt)) ?? all[0] ?? null;
}

function SeasonHeader({ season }: { season: Season | null }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const end = season ? Date.parse(season.endsAt) : null;
  const left = end != null && now != null ? end - now : null;
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-[-0.02em]">
          <Trophy size={22} weight="fill" className="text-brand" /> {season?.name ?? 'Season 0'}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {season ? `${day(season.startsAt)} – ${day(season.endsAt)}` : 'One leaderboard for people and agents.'}
        </p>
      </div>
      {left != null && (
        <div className="text-right" aria-live="off">
          <div className="text-xs text-muted">{left > 0 ? 'Ends in' : 'Season'}</div>
          <div className="font-mono text-lg font-semibold tabular-nums">{left > 0 ? countdown(left) : 'Final'}</div>
        </div>
      )}
    </header>
  );
}

const day = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

function countdown(ms: number) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d}d ${pad(h)}:${pad(m)}:${pad(sec)}`;
}

function Tabs<T extends string>({ items, value, onChange, label }: { items: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="flex rounded-xl bg-white/[0.04] p-1" role="tablist" aria-label={label}>
      {items.map((x) => (
        <button
          key={x.id}
          type="button"
          role="tab"
          aria-selected={value === x.id}
          onClick={() => onChange(x.id)}
          className={`rounded-lg px-3 py-1.5 text-sm transition ${value === x.id ? 'bg-white/[0.08] text-ink' : 'text-muted hover:text-ink'}`}
        >
          {x.label}
        </button>
      ))}
    </div>
  );
}

export function KindBadge({ kind }: { kind: 'human' | 'agent' }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-semibold text-muted">
      {kind === 'agent' ? <Robot size={11} weight="bold" /> : <User size={11} weight="bold" />}
      {kind === 'agent' ? 'Agent' : 'Human'}
    </span>
  );
}

const signedPct = (f: number | null) => (f == null ? '—' : `${f > 0 ? '+' : ''}${Number((f * 100).toFixed(1))}%`);
const signedUsd = (n: number | null) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '-' : ''}${usd(Math.abs(n))}`);
const tone = (n: number | null) => (n == null || n === 0 ? 'text-muted' : n > 0 ? 'text-go' : 'text-risk-high');

function Row({ r, me }: { r: BoardRow; me: boolean }) {
  return (
    <li className={`${GRID} border-b border-white/[0.04] px-4 py-3 last:border-0 md:px-6 ${me ? 'bg-white/[0.05]' : ''}`}>
      <span className={`font-mono text-sm ${r.rank <= 3 ? 'font-semibold text-ink' : 'text-muted'}`}>{r.rank}</span>
      <span className="flex min-w-0 items-center gap-3">
        <MemberAvatar member={r.member} size={36} />
        <span className="min-w-0">
          <Link href={`/u/${r.member.handle}`} className="block truncate font-medium hover:underline">
            @{r.member.handle}
            {me && <span className="ml-1.5 text-xs font-normal text-muted">you</span>}
          </Link>
          <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            <span className="md:hidden">
              <KindBadge kind={r.member.kind} />
            </span>
            {r.member.owner && <span className="truncate">by @{r.member.owner.handle}</span>}
            {r.inclAgents && r.agents.length > 0 && <span className="truncate">+ {r.agents.length} agent{r.agents.length > 1 ? 's' : ''}</span>}
          </span>
        </span>
      </span>
      <span className="hidden md:block">
        <KindBadge kind={r.member.kind} />
      </span>
      <span className={`hidden text-right font-mono text-sm md:block ${tone(r.roi)}`}>{signedPct(r.roi)}</span>
      <span className="hidden text-right font-mono text-sm text-ink/85 md:block">{r.winRate == null ? '—' : `${Math.round(r.winRate * 100)}%`}</span>
      <span className="hidden text-right font-mono text-sm text-ink/85 md:block">{r.trades}</span>
      <span className="text-right font-mono">
        <span className={`block text-sm font-semibold ${tone(r.score ?? r.pnl)}`}>{signedUsd(r.score ?? r.pnl)}</span>
        <span className={`block text-[11px] md:hidden ${tone(r.roi)}`}>{signedPct(r.roi)}</span>
      </span>
    </li>
  );
}

function Pinned({ handle, rank }: { handle: string; rank: Load<MyRank> }) {
  const r = rank.state === 'ready' ? rank.data : null;
  return (
    <div className={`${GRID} border-t border-white/[0.08] bg-white/[0.05] px-4 py-3 md:px-6`}>
      <span className="font-mono text-sm text-ink">{r?.rank ?? '–'}</span>
      <span className="min-w-0">
        <Link href={`/u/${handle}`} className="block truncate font-medium hover:underline">
          @{handle} <span className="text-xs font-normal text-muted">you</span>
        </Link>
        {r && !r.rank && <span className="block truncate text-xs text-muted">{UNRANKED[r.unranked ?? 'ineligible'] ?? UNRANKED.ineligible}</span>}
      </span>
      <span className="hidden md:block" />
      <span className="hidden md:block" />
      <span className="hidden md:block" />
      <span className="hidden md:block" />
      <span className={`text-right font-mono text-sm font-semibold ${tone(r?.score ?? r?.pnl ?? null)}`}>{signedUsd(r?.score ?? r?.pnl ?? null)}</span>
    </div>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="px-6 py-16 text-center">
      <p className="font-medium">{title}</p>
      <p className="mt-1 text-sm text-muted">{text}</p>
    </div>
  );
}

function Skeleton() {
  return (
    <ol aria-label="Loading">
      {Array.from({ length: 6 }, (_, i) => (
        <li key={i} className="flex items-center gap-3 border-b border-white/[0.04] px-4 py-3 last:border-0 md:px-6">
          <span className="h-3 w-4 animate-pulse rounded bg-white/[0.06]" />
          <span className="flex items-center gap-3">
            <span className="size-9 animate-pulse rounded-full bg-white/[0.06]" />
            <span className="h-3 w-28 animate-pulse rounded bg-white/[0.06]" />
          </span>
          <span className="ml-auto h-3 w-14 animate-pulse rounded bg-white/[0.06]" />
        </li>
      ))}
    </ol>
  );
}

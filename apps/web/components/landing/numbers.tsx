import Link from 'next/link';
import { ArrowRight } from '@phosphor-icons/react/dist/ssr';
import { API_URL, getStats } from '@/lib/api';
import { WRAP } from './ui';

/** $RUSHR burned so far (launch burn, first creator-tax buyback, team burn), as listed on /transparency. */
const BURNED_M = 100;

/** Trades and USD volume through Rushr (confirmed trades in the fee ledger), from the transparency API. */
async function getPlatform(): Promise<{ trades: number; volumeUsd: number } | null> {
  try {
    const res = await fetch(`${API_URL}/transparency`, { next: { revalidate: 60 }, signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    const { fees } = (await res.json()) as { fees: { allTime: { trades: number; volumeUsd?: number } } };
    return fees.allTime.volumeUsd == null ? null : { trades: fees.allTime.trades, volumeUsd: fees.allTime.volumeUsd };
  } catch {
    return null;
  }
}

/** Members by kind, counted from the all-members board (it lists every active member, traded or not). */
async function getMembers(): Promise<{ humans: number; agents: number } | null> {
  try {
    const res = await fetch(`${API_URL}/v1/leaderboard?window=30d&kind=all&limit=200`, { next: { revalidate: 300 }, signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return null;
    const { rows } = (await res.json()) as { rows: { member: { kind: string } }[] };
    const agents = rows.filter((r) => r.member.kind === 'agent').length;
    return { humans: rows.length - agents, agents };
  } catch {
    return null;
  }
}

const compact = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : n >= 1_000 ? `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K` : n.toLocaleString('en-US');

function Stat({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="bg-surface px-5 py-5 md:px-6">
      <div className="font-mono text-2xl font-medium tracking-[-0.03em] text-ink tabular-nums md:text-3xl">{value}</div>
      <div className="mt-1 text-sm text-muted">{label}</div>
      {sub && <div className="mt-0.5 font-mono text-[11px] text-muted/80">{sub}</div>}
    </div>
  );
}

/**
 * Live numbers under the hero, from the public API (cached 30 s / 5 min), with a link to the transparency
 * page. A number the API doesn't answer is left out rather than shown as a dash.
 */
export async function Numbers() {
  const [stats, platform, members] = await Promise.all([getStats(), getPlatform(), getMembers()]);
  const tiles = [
    stats && { value: compact(stats.tokens_tracked), label: 'Tokens watched', sub: 'on Robinhood Chain' },
    platform && { value: platform.trades.toLocaleString('en-US'), label: 'Trades', sub: 'through Rushr' },
    platform && { value: `$${compact(Math.round(platform.volumeUsd))}`, label: 'Volume', sub: 'through Rushr' },
    members && { value: (members.humans + members.agents).toLocaleString('en-US'), label: 'Members', sub: `${members.humans} humans · ${members.agents} AI agents` },
  ].filter((t): t is { value: string; label: string; sub: string } => !!t);
  return (
    <section aria-label="Rushr in numbers" className={`${WRAP} -mt-2 md:-mt-4`}>
      <div className="overflow-hidden rounded-2xl border border-line bg-surface">
        {/* 1px gaps over the line colour draw the dividers, for any number of tiles. */}
        <div className={`grid grid-cols-2 gap-px bg-line ${tiles.length >= 4 ? 'md:grid-cols-4' : tiles.length === 3 ? 'md:grid-cols-3' : 'md:grid-cols-2'}`}>
          {tiles.map((t) => (
            <Stat key={t.label} {...t} />
          ))}
        </div>
        <Link
          href="/transparency"
          className="group flex items-center justify-between gap-3 border-t border-line px-5 py-3.5 text-sm transition hover:bg-ink/[0.03] md:px-6"
        >
          <span className="text-muted">
            <span className="font-medium text-ink">{BURNED_M}M $RUSHR burned so far.</span> Every fee, buyback and burn is on-chain.
          </span>
          <span className="flex shrink-0 items-center gap-1.5 font-medium text-ink">
            Transparency <ArrowRight size={14} weight="bold" className="transition group-hover:translate-x-0.5" />
          </span>
        </Link>
      </div>
    </section>
  );
}

/** Same footprint as Numbers while the API answers, so the page doesn't jump. */
export function NumbersFallback() {
  return (
    <section aria-hidden className={`${WRAP} -mt-2 md:-mt-4`}>
      <div className="h-[196px] animate-pulse rounded-2xl border border-line bg-surface md:h-[150px]" />
    </section>
  );
}

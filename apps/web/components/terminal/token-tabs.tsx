'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowSquareOut } from '@phosphor-icons/react';
import { API_URL, type TokenCard } from '@/lib/api';
import { age, compact, EXPLORER, nf, pct, short, usd, usdSigned } from '@/lib/format';
import { useNow } from '@/lib/now';
import {
  coversLaunch,
  earlyBuyers,
  makerTags,
  traders,
  type HolderInfo,
  type MakerContext,
  type MakerTag,
  type TraderRow,
  type Tx,
} from '@/lib/trades';
import { RiskTag, TokenAvatar } from './bits';
import { BubbleMap, type BubbleData } from './bubblemap';
import { TableSkeleton } from './trades-table';
import { TagChip, TagList } from './tags';

/** Retry interval while the API answers 202 (it is still fetching the token from chain). */
const PENDING_RETRY_MS = 5_000;
const PENDING_MAX_TRIES = 36;

/**
 * GET JSON once per URL. A 202 means the API is still fetching the token from chain: `pending`
 * is set and the request retries every few seconds instead of treating the body as data.
 */
export function useFetch<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!url) return;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    setError(false);
    const run = () =>
      fetch(url, { signal: ctl.signal })
        .then(async (r) => {
          if (r.status === 202) {
            await r.body?.cancel();
            setPending(true);
            if (++tries < PENDING_MAX_TRIES) timer = setTimeout(run, PENDING_RETRY_MS);
            else setError(true);
            return;
          }
          if (!r.ok) throw new Error(String(r.status));
          setPending(false);
          setData((await r.json()) as T);
        })
        .catch((e: Error) => e.name !== 'AbortError' && setError(true));
    void run();
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [url]);
  return { data, error, pending };
}

const Fetching = () => <Empty text="Still fetching this token from chain…" sub="This fills in as soon as the first blocks are read." />;

export function Empty({ text, sub }: { text: string; sub?: string }) {
  return (
    <div className="grid h-40 place-items-center px-6 text-center">
      <div>
        <p className="text-sm text-muted">{text}</p>
        {sub && <p className="mt-1 max-w-[52ch] text-[11px] text-muted/70">{sub}</p>}
      </div>
    </div>
  );
}

const Th = ({ children, right, className = '' }: { children?: React.ReactNode; right?: boolean; className?: string }) => (
  <th className={`py-2 font-normal ${right ? 'pr-3 text-right' : 'pl-3'} ${className}`}>{children}</th>
);

function Wallet({ wallet, tags, onMaker }: { wallet: string; tags: MakerTag[]; onMaker?: (w: string) => void }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {onMaker ? (
        <button type="button" onClick={() => onMaker(wallet)} title="Show this wallet's trades" className="font-mono text-ink/85 hover:text-brand">
          {short(wallet, 3, 4)}
        </button>
      ) : (
        <span className="font-mono text-ink/85">{short(wallet, 3, 4)}</span>
      )}
      <a href={`${EXPLORER}/address/${wallet}`} target="_blank" rel="noreferrer" aria-label="Open wallet in explorer" className="text-muted hover:text-ink">
        <ArrowSquareOut size={11} />
      </a>
      <TagList tags={tags} compact max={4} />
    </span>
  );
}

/* ------------------------------------------------------------------ holders */

const HOLDER_FILTERS: MakerTag[] = ['dev', 'whale', 'sniper', 'bundler', 'insider', 'fresh', 'airdrop'];

export function HoldersTab({
  holders,
  total,
  error,
  pending = false,
  ctx,
  priceUsd,
  decimals,
  onMaker,
}: {
  holders: HolderInfo[] | null;
  total: number;
  error: boolean;
  /** The API is still fetching this token from chain (202). */
  pending?: boolean;
  ctx: MakerContext;
  priceUsd: number | null;
  decimals: number;
  onMaker: (w: string) => void;
}) {
  const [only, setOnly] = useState<MakerTag | null>(null);
  const rows = useMemo(
    () => (holders ?? []).map((h, i) => ({ h, rank: i + 1, tags: makerTags(h.wallet, ctx) })),
    [holders, ctx],
  );
  if (pending) return <Fetching />;
  if (error) return <Empty text="Couldn't load holders." />;
  if (!holders) return <TableSkeleton />;
  if (!holders.length) return <Empty text="No holders yet." />;
  const counts = new Map<MakerTag, { n: number; pct: number }>();
  for (const r of rows)
    for (const t of r.tags) {
      const c = counts.get(t) ?? { n: 0, pct: 0 };
      counts.set(t, { n: c.n + 1, pct: c.pct + r.h.pct });
    }
  const top10 = rows.slice(0, 10).reduce((t, r) => t + r.h.pct, 0);
  const shown = only ? rows.filter((r) => r.tags.includes(only)) : rows;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.04] px-3 py-1.5 text-[11px] text-muted">
        <span>
          Top 10 hold <span className={`font-mono ${top10 >= 30 ? 'text-risk-high' : 'text-ink'}`}>{pct(top10)}</span>
        </span>
        <span className="mx-1 h-3 w-px bg-white/10" />
        <button type="button" onClick={() => setOnly(null)} className={`rounded-md px-2 py-0.5 ${only ? 'hover:text-ink' : 'bg-white/[0.1] text-ink'}`}>
          All
        </button>
        {HOLDER_FILTERS.filter((t) => counts.has(t)).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setOnly(only === t ? null : t)}
            className={`flex items-center gap-1 rounded-md px-1 py-0.5 ${only === t ? 'bg-white/[0.08] ring-1 ring-white/30' : 'opacity-75 hover:opacity-100'}`}
          >
            <TagChip tag={t} />
            <span className="font-mono">
              {counts.get(t)!.n} · {pct(counts.get(t)!.pct)}
            </span>
          </button>
        ))}
        <span className="ml-auto">
          Top {holders.length} of {nf.format(total)}
        </span>
      </div>
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-surface text-left text-[11px] text-muted">
          <tr>
            <Th className="w-10">#</Th>
            <Th>Wallet</Th>
            <Th right>Share</Th>
            <Th right className="hidden sm:table-cell">Amount</Th>
            <Th right className="hidden sm:table-cell">Value</Th>
            <Th right className="hidden md:table-cell">Funded by</Th>
          </tr>
        </thead>
        <tbody>
          {shown.map(({ h, rank, tags }) => {
            const amount = toNum(h.amount, decimals);
            return (
              <tr key={h.wallet} className="border-t border-white/[0.03] hover:bg-white/[0.02]">
                <td className="py-1.5 pl-3 font-mono text-muted">{rank}</td>
                <td className="pl-3">
                  <Wallet wallet={h.wallet} tags={tags} onMaker={onMaker} />
                </td>
                <td className="pr-3 text-right font-mono">
                  <span className="inline-flex items-center gap-2">
                    <span className="hidden h-1 w-14 overflow-hidden rounded-full bg-white/[0.06] sm:block">
                      <span className="block h-full bg-brand/70" style={{ width: `${Math.min(100, h.pct * 4)}%` }} />
                    </span>
                    {pct(h.pct, 2)}
                  </span>
                </td>
                <td className="hidden pr-3 text-right font-mono text-ink/80 sm:table-cell">{compact(amount)}</td>
                <td className="hidden pr-3 text-right font-mono text-ink/80 sm:table-cell">{usd(amount != null && priceUsd ? amount * priceUsd : null)}</td>
                <td className="hidden pr-3 text-right font-mono text-muted md:table-cell">
                  {h.funder ? (
                    <a href={`${EXPLORER}/address/${h.funder}`} target="_blank" rel="noreferrer" className="hover:text-ink">
                      {short(h.funder, 3, 3)}
                    </a>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function toNum(raw: string, decimals: number) {
  try {
    const shift = Math.max(0, decimals - 6);
    return Number(BigInt(raw) / 10n ** BigInt(shift)) / 10 ** (decimals - shift);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ top traders */

function Coverage({ trades, serverNow }: { trades: Tx[]; serverNow: number }) {
  const now = useNow(serverNow);
  if (!trades.length) return null;
  const oldest = trades[trades.length - 1]!.time * 1000;
  return (
    <span>
      From the last {nf.format(trades.length)} trades ({age(oldest, now)})
    </span>
  );
}

type TraderSort = 'pnl' | 'bought' | 'sold';

export function TopTradersTab({
  trades,
  ctx,
  priceUsd,
  decimals,
  serverNow,
  onMaker,
}: {
  trades: Tx[] | null;
  ctx: MakerContext;
  priceUsd: number | null;
  decimals: number;
  serverNow: number;
  onMaker: (w: string) => void;
}) {
  const [sort, setSort] = useState<TraderSort>('pnl');
  const rows = useMemo(() => (trades ? traders(trades, ctx, priceUsd, decimals) : null), [trades, ctx, priceUsd, decimals]);
  if (!rows || !trades) return <TableSkeleton />;
  if (!rows.length) return <Empty text="No traders yet." />;
  const key: Record<TraderSort, (r: TraderRow) => number> = { pnl: (r) => r.pnl, bought: (r) => r.boughtUsd, sold: (r) => r.soldUsd };
  const sorted = [...rows].sort((a, b) => key[sort](b) - key[sort](a)).slice(0, 100);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-white/[0.04] px-3 py-1.5 text-[11px] text-muted">
        <span>Sort</span>
        {(['pnl', 'bought', 'sold'] as const).map((s) => (
          <button key={s} type="button" onClick={() => setSort(s)} className={`rounded-md px-2 py-0.5 ${sort === s ? 'bg-white/[0.1] text-ink' : 'hover:text-ink'}`}>
            {s === 'pnl' ? 'PnL' : s === 'bought' ? 'Bought' : 'Sold'}
          </button>
        ))}
        <span className="ml-auto">
          <Coverage trades={trades} serverNow={serverNow} />
        </span>
      </div>
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-surface text-left text-[11px] text-muted">
          <tr>
            <Th className="w-10">#</Th>
            <Th>Wallet</Th>
            <Th right>Bought</Th>
            <Th right>Sold</Th>
            <Th right>PnL</Th>
            <Th right className="hidden sm:table-cell">Holding</Th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {sorted.map((r, i) => (
            <tr key={r.wallet} className="border-t border-white/[0.03] hover:bg-white/[0.02]">
              <td className="py-1.5 pl-3 text-muted">{i + 1}</td>
              <td className="pl-3 font-sans">
                <Wallet wallet={r.wallet} tags={makerTags(r.wallet, ctx)} onMaker={onMaker} />
              </td>
              <td className="pr-3 text-right">
                <span className="text-brand">{usd(r.boughtUsd)}</span>
                <span className="block text-[10px] text-muted">{r.buys} tx</span>
              </td>
              <td className="pr-3 text-right">
                <span className="text-risk-high">{usd(r.soldUsd)}</span>
                <span className="block text-[10px] text-muted">{r.sells} tx</span>
              </td>
              <td className={`pr-3 text-right font-semibold ${r.pnl >= 0 ? 'text-brand' : 'text-risk-high'}`}>{usdSigned(r.pnl)}</td>
              <td className="hidden pr-3 text-right text-ink/80 sm:table-cell">
                {r.holding == null ? (r.boughtTokens - r.soldTokens > 0 ? '~' + compact(r.boughtTokens - r.soldTokens) : '0') : compact(r.holding)}
                {r.holdingPct != null && <span className="block text-[10px] text-muted">{pct(r.holdingPct, 2)}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ early buyers */

const STATUS_STYLE: Record<string, string> = {
  holding: 'text-brand',
  'bought more': 'text-brand',
  'sold some': 'text-risk-medium',
  'sold all': 'text-risk-high',
};

export function EarlyBuyersTab({
  trades,
  fetched,
  limit,
  createdAtMs,
  launchIndexed,
  ctx,
  priceUsd,
  decimals,
  onMaker,
}: {
  trades: Tx[] | null;
  fetched: number;
  limit: number;
  createdAtMs: number;
  launchIndexed: boolean;
  ctx: MakerContext;
  priceUsd: number | null;
  decimals: number;
  onMaker: (w: string) => void;
}) {
  const rows = useMemo(() => {
    if (!trades) return null;
    // Early buyers are measured over the initial history only, not the live tail.
    const hist = trades.slice(trades.length - fetched);
    return earlyBuyers(traders(hist, ctx, priceUsd, decimals), hist, 70);
  }, [trades, fetched, ctx, priceUsd, decimals]);
  if (!rows || !trades) return <TableSkeleton />;
  if (!coversLaunch(trades.slice(trades.length - fetched), createdAtMs, fetched, limit, launchIndexed))
    return (
      <Empty
        text="Early buyers need this token's first trades."
        sub={
          launchIndexed
            ? `This token has more history than the latest ${nf.format(limit)} trades we load. Coming once the API serves trades from launch.`
            : 'Rushr found this token after it launched, so its first trades are not indexed yet.'
        }
      />
    );
  if (!rows.length) return <Empty text="No buyers yet." />;
  const sold = rows.filter((r) => r.status === 'sold all').length;
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.04] px-3 py-1.5 text-[11px] text-muted">
        <span>
          First {rows.length} buyers ·{' '}
          <span className="text-ink">
            {rows.length - sold} still in
          </span>{' '}
          · <span className={sold > rows.length / 2 ? 'text-risk-high' : 'text-ink'}>{sold} sold all</span>
        </span>
      </div>
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-surface text-left text-[11px] text-muted">
          <tr>
            <Th className="w-10">#</Th>
            <Th>Wallet</Th>
            <Th right>Entry</Th>
            <Th right>Bought</Th>
            <Th right className="hidden sm:table-cell">PnL</Th>
            <Th right>Status</Th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {rows.map((r) => (
            <tr key={r.wallet} className="border-t border-white/[0.03] hover:bg-white/[0.02]">
              <td className="py-1.5 pl-3 text-muted">{r.order}</td>
              <td className="pl-3 font-sans">
                <Wallet wallet={r.wallet} tags={makerTags(r.wallet, ctx)} onMaker={onMaker} />
              </td>
              <td className="pr-3 text-right text-muted">+{age(createdAtMs, Math.max(createdAtMs, r.firstTime * 1000))}</td>
              <td className="pr-3 text-right text-brand">{usd(r.boughtUsd)}</td>
              <td className={`hidden pr-3 text-right sm:table-cell ${r.pnl >= 0 ? 'text-brand' : 'text-risk-high'}`}>{usdSigned(r.pnl)}</td>
              <td className={`pr-3 text-right font-sans ${STATUS_STYLE[r.status]}`}>{r.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-[10px] text-muted">Entry is how long after launch the wallet first bought.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ dev tokens */

export function DevTokensTab({ deployer, self, serverNow }: { deployer: string; self: string; serverNow: number }) {
  const { data, error, pending } = useFetch<{ tokens: TokenCard[] }>(deployer ? `${API_URL}/dev/${deployer}` : null);
  const now = useNow(serverNow);
  if (!deployer || pending) return <Fetching />;
  if (error) return <Empty text="Couldn't load the dev's tokens." />;
  if (!data) return <TableSkeleton />;
  const list = data.tokens.filter(Boolean);
  const migrated = list.filter((x) => x.status === 'migrated').length;
  const best = Math.max(0, ...list.map((x) => x.ath_market_cap_usd ?? 0));
  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 border-b border-white/[0.04] px-3 py-1.5 text-[11px] text-muted">
        <span>
          <span className="font-mono text-ink">{list.length}</span> launches
        </span>
        <span>
          <span className={`font-mono ${migrated ? 'text-brand' : 'text-ink'}`}>{migrated}</span> migrated
        </span>
        <span>
          Best ATH <span className="font-mono text-ink">{usd(best || null)}</span>
        </span>
        <a href={`${EXPLORER}/address/${deployer}`} target="_blank" rel="noreferrer" className="ml-auto font-mono hover:text-ink">
          {short(deployer)}
        </a>
      </div>
      <table className="w-full text-xs">
        <thead className="sticky top-0 z-10 bg-surface text-left text-[11px] text-muted">
          <tr>
            <Th>Token</Th>
            <Th right className="hidden sm:table-cell">Age</Th>
            <Th right>MC</Th>
            <Th right className="hidden sm:table-cell">ATH</Th>
            <Th right className="hidden md:table-cell">Holders</Th>
            <Th right>Status</Th>
          </tr>
        </thead>
        <tbody>
          {list.map((x) => (
            <tr key={x.address} className={`border-t border-white/[0.03] hover:bg-white/[0.02] ${x.address === self ? 'bg-brand/[0.04]' : ''}`}>
              <td className="py-1.5 pl-3">
                <Link href={`/token/${x.address}`} className="flex items-center gap-2 hover:text-brand">
                  <TokenAvatar t={x} size={22} />
                  <span className="font-semibold">{x.symbol}</span>
                  <span className="hidden max-w-[14ch] truncate text-muted sm:inline">{x.name}</span>
                  {x.address === self && <span className="text-[10px] text-muted">(this)</span>}
                </Link>
              </td>
              <td className="hidden pr-3 text-right font-mono text-muted sm:table-cell">{age(new Date(x.created_at).getTime(), now)}</td>
              <td className="pr-3 text-right font-mono">{usd(x.market_cap_usd)}</td>
              <td className="hidden pr-3 text-right font-mono text-ink/80 sm:table-cell">{usd(x.ath_market_cap_usd)}</td>
              <td className="hidden pr-3 text-right font-mono text-ink/80 md:table-cell">{nf.format(x.holders)}</td>
              <td className="pr-3 text-right">
                <span className="inline-flex items-center gap-1.5">
                  {x.status === 'migrated' && <span className="rounded-md bg-brand/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand">migrated</span>}
                  <RiskTag risk={x.risk} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ bubble map */

export function BubblesTab({ address }: { address: string }) {
  const { data, error, pending } = useFetch<BubbleData>(`${API_URL}/tokens/${address}/bubblemap`);
  if (pending) return <Fetching />;
  if (error) return <Empty text="Couldn't load the bubble map." />;
  if (!data) return <TableSkeleton />;
  if (!data.nodes.length) return <Empty text="No holders to map yet." />;
  return <BubbleMap data={data} />;
}

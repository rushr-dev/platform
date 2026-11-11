'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowSquareOut, Check, Copy, Lightning, Warning, WarningOctagon, Info, CheckCircle } from '@phosphor-icons/react';
import { API_URL, type Candle, type SignalReason, type TokenCard, type TokenDetail, type Trade } from '@/lib/api';
import { age, LAUNCHPAD_LABEL, nf, pct, price, short, usd } from '@/lib/format';
import { useLive } from '@/lib/live';
import { RiskTag, SocialLinks, TokenAvatar, riskText } from './bits';
import { BubbleMap, type BubbleData } from './bubblemap';
import { PriceChart, type Tick } from './chart';

const EXPLORER = 'https://robinhoodchain.blockscout.com';

interface LiveTrade {
  tx: string;
  logIndex: number;
  time: number;
  trader: string;
  side: 'buy' | 'sell';
  priceUsd: number | null;
  usd: number | null;
}

interface Holder {
  wallet: string;
  pct: number;
  tags: string[];
  funder: string | null;
}

export function TokenView({
  detail,
  initialTrades,
  candles,
  serverNow,
}: {
  detail: TokenDetail;
  initialTrades: Trade[];
  candles: Candle[];
  serverNow: number;
}) {
  const [t, setT] = useState<TokenDetail>(detail);
  const [trades, setTrades] = useState<Trade[]>(initialTrades);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [now, setNow] = useState(serverNow);
  const supply = Number(BigInt(detail.total_supply) / 10n ** BigInt(Math.max(0, detail.decimals - 6))) / 1e6;

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useLive(`token:${detail.address}`, (e) => {
    if (e.type === 'token') setT((prev) => ({ ...prev, ...(e.data as TokenCard) }));
    if (e.type === 'trades') {
      const fresh = (e.data as LiveTrade[]).map<Trade>((x) => ({
        tx: x.tx, log_index: x.logIndex, time: new Date(x.time * 1000).toISOString(), trader: x.trader, side: x.side, price_usd: x.priceUsd, usd: x.usd,
      }));
      setTrades((prev) => {
        const seen = new Set(prev.map((p) => `${p.tx}:${p.log_index}`));
        return [...fresh.filter((f) => !seen.has(`${f.tx}:${f.log_index}`)).reverse(), ...prev].slice(0, 300);
      });
      setTicks((prev) => [
        ...(e.data as LiveTrade[]).filter((x) => x.priceUsd).map((x) => ({ time: x.time, priceUsd: x.priceUsd!, usd: x.usd })).reverse(),
        ...prev,
      ].slice(0, 2000));
    }
  });

  const change = useMemo(() => {
    const first = candles.find((c) => c.open > 0);
    const p = t.price_usd ?? null;
    return first && p ? ((p - first.open) / first.open) * 100 : null;
  }, [candles, t.price_usd]);

  return (
    <div className="grid h-full min-h-0 gap-2 p-2 lg:grid-cols-[1fr_340px]">
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto lg:overflow-hidden">
        <Header t={t} change={change} now={now} />
        <div className="h-[380px] shrink-0 overflow-hidden rounded-2xl border border-white/[0.06] bg-surface lg:h-auto lg:min-h-[300px] lg:flex-[1.2]">
          <PriceChart address={t.address} initial={candles} supply={supply} ticks={ticks} />
        </div>
        <Tabs t={t} trades={trades} now={now} />
      </div>
      <aside className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        <TradeBox symbol={t.symbol} />
        <Safety t={t} />
        <DevRecord t={t} />
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ header */

function Header({ t, change, now }: { t: TokenDetail; change: number | null; now: number }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(t.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-2xl border border-white/[0.06] bg-surface px-4 py-3">
      <div className="flex items-center gap-3">
        <TokenAvatar t={t} size={44} badge />
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-[-0.02em]">{t.symbol}</h1>
            <span className="max-w-[16ch] truncate text-sm text-muted">{t.name}</span>
            <RiskTag risk={t.risk} />
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
            <button type="button" onClick={copy} className="flex items-center gap-1 font-mono hover:text-ink">
              {short(t.address)} {copied ? <Check size={12} className="text-brand" /> : <Copy size={12} />}
            </button>
            <span>·</span>
            <span>{LAUNCHPAD_LABEL[t.launchpad ?? ''] ?? t.launchpad}</span>
            <span>·</span>
            <span>{age(new Date(t.created_at).getTime(), now)} old</span>
            <a href={`${EXPLORER}/token/${t.address}`} target="_blank" rel="noreferrer" className="hover:text-ink" aria-label="Open in explorer">
              <ArrowSquareOut size={12} />
            </a>
            <span>·</span>
            <SocialLinks t={t} size={14} />
          </div>
          {t.description && <p className="mt-1 max-w-[60ch] truncate text-xs text-ink/70" title={t.description}>{t.description}</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-7 gap-y-2">
        <Stat k="Market cap" v={usd(t.market_cap_usd)} big />
        <Stat k="Price" v={price(t.price_usd)} sub={change == null ? undefined : `${change >= 0 ? '▲' : '▼'} ${Math.abs(change).toFixed(1)}%`} up={(change ?? 0) >= 0} />
        <Stat k="24h volume" v={usd(t.volume_24h_usd)} />
        <Stat k="Holders" v={nf.format(t.holders)} />
        <Stat k="ATH mcap" v={usd(t.ath_market_cap_usd)} />
        {t.status !== 'migrated' && t.bonding_progress != null && <Stat k="Bonding" v={pct(t.bonding_progress * 100, 0)} />}
      </div>
    </div>
  );
}

function Stat({ k, v, sub, up, big }: { k: string; v: string; sub?: string; up?: boolean; big?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{k}</div>
      <div className={`font-mono ${big ? 'text-lg font-semibold' : 'text-sm'}`}>
        {v}
        {sub && <span className={`ml-1.5 text-xs ${up ? 'text-brand' : 'text-risk-high'}`}>{sub}</span>}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ right rail */

function TradeBox({ symbol }: { symbol: string }) {
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
            className="rounded-lg border border-white/[0.06] py-1.5 font-mono text-xs text-muted hover:text-ink"
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
      {!t.launch_indexed && (
        <p className="mt-2 text-xs text-muted">Found after launch. Launch-time checks fill in once its first blocks are indexed.</p>
      )}
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

type Tab = 'trades' | 'holders' | 'bubbles' | 'dev';

function Tabs({ t, trades, now }: { t: TokenDetail; trades: Trade[]; now: number }) {
  const [tab, setTab] = useState<Tab>('trades');
  const tabs: [Tab, string][] = [
    ['trades', 'Trades'],
    ['holders', `Holders ${nf.format(t.holders)}`],
    ['bubbles', 'Bubble map'],
    ['dev', "Dev's tokens"],
  ];
  return (
    <div className="flex min-h-[320px] flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-surface lg:min-h-0 lg:flex-1">
      <div className="flex gap-1 border-b border-white/[0.05] px-2 py-2">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium ${tab === id ? 'bg-white/[0.08] text-ink' : 'text-muted hover:text-ink'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'trades' && <Trades trades={trades} now={now} />}
        {tab === 'holders' && <Holders address={t.address} deployer={t.deployer} />}
        {tab === 'bubbles' && <Bubbles address={t.address} />}
        {tab === 'dev' && <DevTokens deployer={t.deployer} self={t.address} />}
      </div>
    </div>
  );
}

function Trades({ trades, now }: { trades: Trade[]; now: number }) {
  if (!trades.length) return <Empty text="No trades yet." />;
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-surface text-left text-[11px] text-muted">
        <tr>
          <th className="px-4 py-2 font-normal">Age</th>
          <th className="py-2 font-normal">Type</th>
          <th className="py-2 text-right font-normal">USD</th>
          <th className="py-2 text-right font-normal">Price</th>
          <th className="px-4 py-2 text-right font-normal">Trader</th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {trades.map((x) => (
          <tr key={`${x.tx}:${x.log_index}`} className="border-t border-white/[0.03] hover:bg-white/[0.02]">
            <td className="px-4 py-1.5 text-muted">{age(new Date(x.time).getTime(), now)}</td>
            <td className={x.side === 'buy' ? 'text-brand' : 'text-risk-high'}>{x.side === 'buy' ? 'Buy' : 'Sell'}</td>
            <td className={`text-right ${x.side === 'buy' ? 'text-brand' : 'text-risk-high'}`}>{usd(x.usd)}</td>
            <td className="text-right text-ink/80">{price(x.price_usd)}</td>
            <td className="px-4 text-right">
              <a href={`${EXPLORER}/tx/${x.tx}`} target="_blank" rel="noreferrer" className="text-muted hover:text-ink">
                {short(x.trader)}
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function useFetch<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    fetch(url, { signal: ctl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status)))))
      .then(setData)
      .catch((e: Error) => e.name !== 'AbortError' && setError(true));
    return () => ctl.abort();
  }, [url]);
  return { data, error };
}

const TAG_STYLE: Record<string, string> = {
  dev: 'bg-white/15 text-ink',
  sniper: 'bg-risk-medium/15 text-risk-medium',
  bundler: 'bg-risk-high/15 text-risk-high',
  insider: 'bg-risk-high/15 text-risk-high',
  fresh: 'bg-[#5ec8ff]/15 text-[#5ec8ff]',
  airdrop: 'bg-[#b58cff]/15 text-[#b58cff]',
};

function Holders({ address, deployer }: { address: string; deployer: string }) {
  const { data, error } = useFetch<{ holders: Holder[]; total: number }>(`${API_URL}/tokens/${address}/holders`);
  if (error) return <Empty text="Couldn't load holders." />;
  if (!data) return <Skeleton />;
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-surface text-left text-[11px] text-muted">
        <tr>
          <th className="w-10 px-4 py-2 font-normal">#</th>
          <th className="py-2 font-normal">Wallet</th>
          <th className="py-2 font-normal">Tags</th>
          <th className="px-4 py-2 text-right font-normal">Share</th>
        </tr>
      </thead>
      <tbody>
        {data.holders.slice(0, 100).map((h, i) => (
          <tr key={h.wallet} className="border-t border-white/[0.03] hover:bg-white/[0.02]">
            <td className="px-4 py-1.5 font-mono text-muted">{i + 1}</td>
            <td className="font-mono">
              <a href={`${EXPLORER}/address/${h.wallet}`} target="_blank" rel="noreferrer" className="hover:text-brand">
                {short(h.wallet)}
              </a>
            </td>
            <td>
              <span className="flex flex-wrap gap-1">
                {(h.wallet === deployer ? ['dev', ...h.tags.filter((x) => x !== 'dev')] : h.tags).map((tag) => (
                  <span key={tag} className={`rounded px-1.5 py-px text-[10px] font-semibold ${TAG_STYLE[tag] ?? 'bg-white/10 text-muted'}`}>
                    {tag}
                  </span>
                ))}
              </span>
            </td>
            <td className="px-4 text-right font-mono">
              <span className="inline-flex items-center gap-2">
                <span className="hidden h-1 w-16 overflow-hidden rounded-full bg-white/[0.06] sm:block">
                  <span className="block h-full bg-brand/70" style={{ width: `${Math.min(100, h.pct * 4)}%` }} />
                </span>
                {pct(h.pct, 2)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Bubbles({ address }: { address: string }) {
  const { data, error } = useFetch<BubbleData>(`${API_URL}/tokens/${address}/bubblemap`);
  if (error) return <Empty text="Couldn't load the bubble map." />;
  if (!data) return <Skeleton />;
  return <BubbleMap data={data} />;
}

function DevTokens({ deployer, self }: { deployer: string; self: string }) {
  const { data, error } = useFetch<{ tokens: TokenCard[] }>(`${API_URL}/dev/${deployer}`);
  if (error) return <Empty text="Couldn't load the dev's tokens." />;
  if (!data) return <Skeleton />;
  return (
    <ul>
      {data.tokens.map((x) => (
        <li key={x.address} className="border-t border-white/[0.03] first:border-0">
          <Link href={`/token/${x.address}`} className={`flex items-center gap-3 px-4 py-2 hover:bg-white/[0.02] ${x.address === self ? 'bg-white/[0.03]' : ''}`}>
            <TokenAvatar t={x} size={28} />
            <span className="min-w-0 flex-1">
              <span className="text-sm font-semibold">{x.symbol}</span>
              <span className="ml-2 text-xs text-muted">{new Date(x.created_at).toLocaleDateString()}</span>
            </span>
            <span className="font-mono text-xs">{usd(x.market_cap_usd)}</span>
            <RiskTag risk={x.risk} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="grid h-40 place-items-center text-sm text-muted">{text}</div>;
}

function Skeleton() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="h-6 animate-pulse rounded-md bg-white/[0.04]" />
      ))}
    </div>
  );
}

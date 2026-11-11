import Image from 'next/image';
import Link from 'next/link';
import { ArrowRight, Robot, TelegramLogo, XLogo } from '@phosphor-icons/react/dist/ssr';
import type { RiskLevel, Stats, TokenCard, Trade } from '@/lib/api';
import { Reveal } from './reveal';

const X_URL = 'https://x.com/rushrtrade';
const TELEGRAM_URL = 'https://t.me/rushrtrade';

const nf = new Intl.NumberFormat('en-US');
const usd = (n: number | null | undefined) =>
  n == null
    ? 'n/a'
    : n >= 1e9
      ? `$${(n / 1e9).toFixed(1)}B`
      : n >= 1e6
        ? `$${(n / 1e6).toFixed(1)}M`
        : n >= 1e3
          ? `$${(n / 1e3).toFixed(1)}K`
          : `$${n.toFixed(0)}`;
const pct = (n: number | null | undefined) => (n == null ? 'n/a' : `${n}%`);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const age = (iso: string) => {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/* Token avatars: no logos are indexed yet, so each ticker gets a stable colour from its address. */
const HUES = ['#36d42a', '#ffb547', '#5ec8ff', '#ff7ab6', '#b58cff', '#ff6b5b', '#a6ff4d', '#4de0c2'];
const hue = (a: string) => HUES[parseInt(a.slice(2, 6), 16) % HUES.length]!;
function TokenAvatar({ t, size = 28 }: { t: Pick<TokenCard, 'address' | 'symbol'>; size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full font-semibold text-[#0b120c]"
      style={{ width: size, height: size, background: hue(t.address), fontSize: size * 0.4 }}
    >
      {t.symbol.slice(0, 1)}
    </span>
  );
}

function RiskTag({ risk, className = '' }: { risk: RiskLevel | null; className?: string }) {
  const r = risk ?? 'unknown';
  const cls =
    r === 'high'
      ? 'bg-risk-high/15 text-risk-high'
      : r === 'medium'
        ? 'bg-risk-medium/15 text-risk-medium'
        : r === 'low'
          ? 'bg-brand/15 text-brand'
          : 'bg-ink/10 text-muted';
  return (
    <span className={`shrink-0 whitespace-nowrap rounded-[4px] px-1.5 py-0.5 text-[10px] font-medium ${cls} ${className}`}>
      {r === 'unknown' ? 'checking' : `${r} risk`}
    </span>
  );
}

/* ---------------------------------------------------------------- nav */

export function Nav() {
  return (
    <header className="sticky top-0 z-30 border-b border-line/70 bg-bg/80 backdrop-blur-md">
      <nav className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 md:px-8">
        <div className="flex items-center gap-10">
          <Link href="/" className="flex items-center gap-2" aria-label="Rushr home">
            <Image src="/logo-mark.png" alt="" width={26} height={26} priority />
            <span className="text-xl font-semibold tracking-[-0.04em]">rushr</span>
          </Link>
          <div className="hidden items-center gap-7 text-sm text-muted md:flex">
            <a href="#trenches" className="transition-colors hover:text-ink">Trenches</a>
            <a href="#social" className="transition-colors hover:text-ink">Social</a>
            <a href="#agents" className="transition-colors hover:text-ink">Agents</a>
            <a href="#safety" className="transition-colors hover:text-ink">Safety</a>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={X_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Rushr on X"
            className="hidden size-9 place-items-center rounded-lg border border-line text-muted transition hover:text-ink sm:grid"
          >
            <XLogo size={16} weight="bold" />
          </a>
          <Link
            href="/trenches"
            className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-bg transition hover:bg-ink/85 active:scale-[0.98]"
          >
            Open app
          </Link>
        </div>
      </nav>
    </header>
  );
}

/* ---------------------------------------------------------------- hero */

export function Hero({ stats }: { stats: Stats | null }) {
  return (
    <section className="relative isolate overflow-hidden">
      <div className="relative z-10 mx-auto flex max-w-7xl flex-col items-center px-4 pt-14 text-center md:px-8 md:pt-20">
        <h1 className="rise text-[96px] font-semibold leading-[0.9] tracking-[-0.07em] sm:text-[140px] md:text-[168px]">
          rushr
        </h1>
        <p className="rise mt-3 text-2xl font-medium tracking-[-0.03em] md:text-4xl" style={{ animationDelay: '0.06s' }}>
          trade the rush. together.
        </p>
        <p className="rise mt-3 max-w-[46ch] text-base text-muted md:text-lg" style={{ animationDelay: '0.12s' }}>
          Follow the wallets that win, copy them in one tap, or let an agent trade for you. Every token checked first.
        </p>
        <div className="rise mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row" style={{ animationDelay: '0.18s' }}>
          <Link
            href="/trenches"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-go px-7 py-3.5 font-semibold text-[#0b120c] shadow-[0_12px_32px_-14px_rgba(42,138,34,0.8)] transition hover:brightness-105 active:scale-[0.98]"
          >
            Enter the trenches
          </Link>
          <a
            href={TELEGRAM_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-line bg-surface px-7 py-3.5 font-semibold transition hover:border-ink/20 active:scale-[0.98]"
          >
            <TelegramLogo size={18} weight="fill" />
            Join the crew
          </a>
        </div>
        {stats && (
          <p
            className="rise mt-6 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.16em] text-muted"
            style={{ animationDelay: '0.24s' }}
          >
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-go/60 motion-reduce:hidden" />
              <span className="relative inline-flex size-2 rounded-full bg-go" />
            </span>
            {nf.format(stats.launches_24h)} launches today on Robinhood Chain
          </p>
        )}
      </div>

      {/* Key visual: the brand banner, blended into the paper and faded out at the bottom */}
      <div
        className="rise relative mx-auto mt-10 aspect-[16/10] w-full max-w-[1440px] [mask-image:linear-gradient(to_bottom,transparent,black_14%,black_72%,transparent)] sm:aspect-[2/1] md:mt-12 lg:aspect-[3/1]"
        style={{ animationDelay: '0.3s' }}
      >
        <Image
          src="/art/banner.jpg"
          alt="Traders in togas gathered in a classical forum under the green Rushr banner, checking charts on tablets and phones"
          fill
          priority
          sizes="(min-width: 1440px) 1440px, 100vw"
          className="object-cover object-[50%_40%] mix-blend-multiply"
        />
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- product shot */

/** Group real swaps into candles so the product shot shows a token's actual price path. */
function candlesFromTrades(trades: Trade[], bars = 34) {
  const pts = trades
    .filter((t) => t.price_usd)
    .sort((a, b) => a.time.localeCompare(b.time))
    .map((t) => t.price_usd!);
  if (pts.length < 4) return [];
  const per = Math.max(1, Math.ceil(pts.length / bars));
  const out: { o: number; h: number; l: number; c: number }[] = [];
  for (let i = 0; i < pts.length; i += per) {
    const g = pts.slice(Math.max(0, i - 1), i + per);
    out.push({ o: g[0]!, c: g[g.length - 1]!, h: Math.max(...g), l: Math.min(...g) });
  }
  return out;
}

function CandleChart({ trades }: { trades: Trade[] }) {
  const cs = candlesFromTrades(trades);
  if (!cs.length) return <div className="grid h-full place-items-center text-xs text-muted">chart loading</div>;
  const W = 600;
  const H = 230;
  const lo = Math.log(Math.min(...cs.map((c) => c.l)));
  const hi = Math.log(Math.max(...cs.map((c) => c.h)));
  const y = (v: number) => H - 12 - ((Math.log(v) - lo) / (hi - lo || 1)) * (H - 24);
  const step = W / cs.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-full w-full" preserveAspectRatio="none" aria-hidden>
      {[0.25, 0.5, 0.75].map((g) => (
        <line key={g} x1="0" x2={W} y1={H * g} y2={H * g} stroke="rgba(255,255,255,0.05)" />
      ))}
      {cs.map((c, i) => {
        const col = c.c >= c.o ? '#36d42a' : '#ff6b5b';
        const x = i * step + step / 2;
        const top = y(Math.max(c.o, c.c));
        const bot = y(Math.min(c.o, c.c));
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={y(c.h)} y2={y(c.l)} stroke={col} strokeWidth="1" />
            <rect x={x - step * 0.32} y={top} width={step * 0.64} height={Math.max(2, bot - top)} fill={col} rx="1" />
          </g>
        );
      })}
    </svg>
  );
}

export function ProductShot({ fresh, focus, trades }: { fresh: TokenCard[]; focus: TokenCard; trades: Trade[] }) {
  return (
    <section id="trenches" className="relative scroll-mt-16 pt-6 md:pt-4">
      <div className="mx-auto max-w-7xl px-4 md:px-8">
        <Reveal className="text-center">
          <p className="font-mono text-xs font-medium uppercase tracking-[0.2em] text-brand">Live on Robinhood Chain</p>
          <h2 className="mx-auto mt-4 max-w-[15ch] text-4xl font-semibold leading-[1.02] tracking-[-0.045em] md:text-6xl">
            every launch. before everyone else.
          </h2>
          <p className="mx-auto mt-4 max-w-[46ch] text-muted md:text-lg">
            New pairs stream in the second they hit the chain, with a safety verdict already on the card.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="relative mt-14 md:mt-16">
          {/* Desktop terminal, filled with live data from the indexer */}
          <div className="theme-terminal overflow-hidden rounded-2xl border border-black/10 bg-surface shadow-[0_50px_100px_-40px_rgba(24,32,26,0.55),0_0_0_6px_rgba(24,32,26,0.04)]">
            <div className="flex items-center gap-6 border-b border-white/5 px-4 py-3">
              <span className="flex items-center gap-1.5 text-sm font-semibold tracking-[-0.03em]">
                <Image src="/logo-mark.png" alt="" width={16} height={16} />
                rushr
              </span>
              <div className="hidden gap-5 text-xs text-muted md:flex">
                <span className="text-ink">Trenches</span>
                <span>Feed</span>
                <span>Agents</span>
                <span>Leaderboard</span>
              </div>
              <div className="ml-auto hidden w-64 rounded-md bg-white/5 px-3 py-1.5 text-xs text-muted md:block">
                Search token, wallet or dev
              </div>
            </div>

            <div className="grid md:grid-cols-[250px_1fr] lg:grid-cols-[260px_1fr_270px]">
              {/* New pairs */}
              <div className="hidden border-r border-white/5 md:block">
                <div className="flex items-center justify-between px-4 py-3 text-xs">
                  <span className="font-semibold">New pairs</span>
                  <span className="flex items-center gap-1 text-brand">
                    <span className="size-1.5 rounded-full bg-brand" /> live
                  </span>
                </div>
                <ul>
                  {fresh.slice(0, 7).map((t) => (
                    <li key={t.address} className="flex items-center gap-2.5 border-t border-white/5 px-4 py-2.5">
                      <TokenAvatar t={t} size={26} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className="truncate font-semibold">{t.symbol}</span>
                          <span className="text-muted">{age(t.created_at)}</span>
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-muted">
                          MC {usd(t.market_cap_usd)} · {t.holders} holders
                        </div>
                      </div>
                      <RiskTag risk={t.risk} />
                    </li>
                  ))}
                </ul>
              </div>

              {/* Chart */}
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-white/5 px-4 py-3">
                  <div className="flex items-center gap-2">
                    <TokenAvatar t={focus} size={28} />
                    <div>
                      <div className="text-sm font-semibold">{focus.symbol}</div>
                      <div className="font-mono text-[10px] text-muted">{short(focus.address)}</div>
                    </div>
                  </div>
                  <Stat k="Market cap" v={usd(focus.market_cap_usd)} />
                  <Stat k="24h vol" v={usd(focus.volume_24h_usd)} />
                  <Stat k="Holders" v={nf.format(focus.holders)} />
                  <Stat k="Top 10" v={pct(focus.top10_pct)} />
                </div>
                <div className="h-[220px] px-2 py-3 md:h-[300px]">
                  <CandleChart trades={trades} />
                </div>
                <div className="border-t border-white/5">
                  {trades.slice(0, 4).map((t) => (
                    <div key={`${t.tx}:${t.log_index}`} className="flex items-center gap-4 px-4 py-2 font-mono text-[11px]">
                      <span className={t.side === 'buy' ? 'w-8 text-brand' : 'w-8 text-risk-high'}>{t.side}</span>
                      <span className="w-16 text-ink">{usd(t.usd)}</span>
                      <span className="text-muted">{short(t.trader)}</span>
                      <span className="ml-auto text-muted">{age(t.time)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Trade box + safety */}
              <div className="hidden border-l border-white/5 p-4 lg:block">
                <div className="grid grid-cols-2 rounded-lg bg-white/5 p-1 text-center text-xs font-semibold">
                  <span className="rounded-md bg-go py-1.5 text-[#0b120c]">Buy</span>
                  <span className="py-1.5 text-muted">Sell</span>
                </div>
                <div className="mt-3 grid grid-cols-4 gap-1.5 font-mono text-[11px]">
                  {['0.01', '0.05', '0.1', '0.5'].map((v) => (
                    <span key={v} className="rounded-md border border-white/10 py-1.5 text-center text-muted">
                      {v}
                    </span>
                  ))}
                </div>
                <div className="mt-5 flex items-center justify-between text-xs">
                  <span className="font-semibold">Safety check</span>
                  <RiskTag risk={focus.risk} />
                </div>
                <dl className="mt-3 space-y-2 text-[11px]">
                  <Row k="Launch bundle" v={pct(focus.bundled_pct)} />
                  <Row k="Snipers" v={pct(focus.snipers_pct)} />
                  <Row k="Insiders" v={pct(focus.insiders_pct)} />
                  <Row k="Dev holds" v={pct(focus.dev_pct)} />
                  <Row k="Copycat" v={focus.copycat ? 'yes' : 'no'} />
                </dl>
                <p className="mt-4 border-t border-white/5 pt-3 text-[11px] leading-relaxed text-muted">{focus.verdict}</p>
              </div>
            </div>
          </div>

          {/* Phone with the social feed, overlapping the desktop */}
          <div className="theme-terminal absolute -bottom-20 -right-2 hidden w-[230px] rotate-[4deg] rounded-[34px] border border-black/20 bg-[#0a0d0b] p-2 shadow-[0_30px_70px_-20px_rgba(24,32,26,0.6)] xl:-right-12 xl:block">
            <div className="rounded-[27px] bg-surface p-3">
              <div className="mx-auto h-4 w-16 rounded-full bg-black" />
              <div className="mt-3 text-[11px] font-semibold">Feed</div>
              <ul className="mt-2 space-y-2.5">
                {FEED.map((f) => (
                  <li key={f.who} className="rounded-xl bg-white/[0.04] p-2.5">
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <Avatar who={f.who} agent={f.agent} size={20} />
                      <span className="font-semibold">{f.who}</span>
                      <Side side={f.side} small />
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-muted">
                      ${f.sym} · {f.amt}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="text-[10px] text-muted">{k}</div>
      <div className="font-mono text-xs">{v}</div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{k}</dt>
      <dd className="font-mono">{v}</dd>
    </div>
  );
}

function Avatar({ who, agent, size }: { who: string; agent: boolean; size: number }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full font-bold ${agent ? 'bg-go text-[#0b120c]' : 'bg-ink/10'}`}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {agent ? <Robot size={size * 0.5} weight="bold" /> : who[0]!.toUpperCase()}
    </span>
  );
}

function Side({ side, small = false }: { side: 'Buy' | 'Sell'; small?: boolean }) {
  return (
    <span
      className={`rounded px-1.5 font-semibold ${small ? 'text-[8px]' : 'text-[11px]'} ${
        side === 'Buy' ? 'bg-brand/20 text-brand' : 'bg-risk-high/20 text-risk-high'
      }`}
    >
      {side}
    </span>
  );
}

/* ---------------------------------------------------------------- social grid */

/* Example social activity. Feed, leaderboard and agents are not live yet; tokens are real. */
const FEED: { who: string; side: 'Buy' | 'Sell'; sym: string; amt: string; agent: boolean; note?: string }[] = [
  { who: 'kaito.hood', side: 'Buy', sym: 'ZOLVA', amt: '$1.2K at $61K MC', agent: false, note: "we're so back" },
  { who: 'Scout', side: 'Sell', sym: 'ROOQ', amt: '+38% in 14m', agent: true },
  { who: 'mira', side: 'Buy', sym: 'ROBOT', amt: '$420 at $25K MC', agent: false },
  { who: 'degen.eth', side: 'Sell', sym: 'ONION', amt: '$880 at $30K MC', agent: false },
];

const LEADERS = [
  { who: 'kaito.hood', handle: '@kaitohood', pnl: '+$48,210' },
  { who: 'mira', handle: '@mira_trades', pnl: '+$31,904' },
  { who: 'degen.eth', handle: '@degeneth', pnl: '+$22,577' },
  { who: 'sherwood', handle: '@sherwood', pnl: '+$14,030' },
];

/* Bubble map sample: a healthy spread of holders on the left, one funder's cluster on the right. */
const BUBBLES = [
  { x: 88, y: 92, r: 30, bad: false },
  { x: 150, y: 60, r: 18, bad: false },
  { x: 40, y: 150, r: 14, bad: false },
  { x: 132, y: 150, r: 20, bad: false },
  { x: 60, y: 40, r: 11, bad: false },
  { x: 190, y: 120, r: 10, bad: false },
  { x: 250, y: 70, r: 22, bad: true },
  { x: 290, y: 108, r: 17, bad: true },
  { x: 245, y: 130, r: 15, bad: true },
  { x: 300, y: 52, r: 12, bad: true },
  { x: 318, y: 150, r: 10, bad: true },
];
const LINKS = [
  [88, 92, 150, 60, false],
  [88, 92, 132, 150, false],
  [88, 92, 40, 150, false],
  [250, 70, 290, 108, true],
  [250, 70, 245, 130, true],
  [250, 70, 300, 52, true],
  [290, 108, 318, 150, true],
  [245, 130, 290, 108, true],
] as const;

function Card({
  id,
  eyebrow,
  title,
  soon = false,
  children,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  soon?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      id={id}
      className="relative flex h-full min-h-[420px] scroll-mt-24 flex-col overflow-hidden rounded-3xl border border-line bg-surface p-7 shadow-[0_1px_2px_rgba(24,32,26,0.04),0_20px_40px_-30px_rgba(24,32,26,0.25)] md:min-h-[460px] md:p-8"
    >
      <p className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-[0.16em] text-brand">
        {eyebrow}
        {soon && <span className="rounded bg-ink/[0.07] px-1.5 py-px text-[10px] tracking-wider text-muted">soon</span>}
      </p>
      <h3 className="mt-3 max-w-[17ch] text-[28px] font-semibold leading-[1.08] tracking-[-0.035em]">{title}</h3>
      <div className="relative mt-auto pt-8">{children}</div>
    </div>
  );
}

export function Social({ real, clone }: { real: TokenCard; clone: TokenCard }) {
  return (
    <section id="social" className="mx-auto max-w-7xl scroll-mt-16 px-4 pt-32 md:px-8 md:pt-48">
      <div className="grid items-end gap-6 md:grid-cols-[1fr_minmax(0,460px)]">
        <Reveal>
          <h2 className="text-4xl font-semibold leading-[1.02] tracking-[-0.045em] md:text-6xl">never ape blind.</h2>
          <p className="mt-3 text-lg text-muted md:text-xl">the social trading app that checks every token first.</p>
        </Reveal>
        <Reveal delay={0.1} className="relative -mb-6 hidden aspect-[3/2] md:block">
          <Image
            src="/art/scholar.webp"
            alt="A classical scholar studying coins through a magnifying lens beside a scroll mapped with connected circles"
            fill
            sizes="460px"
            className="object-cover mix-blend-multiply [mask-image:radial-gradient(ellipse_70%_70%_at_50%_50%,black_55%,transparent)]"
          />
        </Reveal>
      </div>

      <div className="mt-12 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <Reveal>
          <Card eyebrow="Leaderboard" title="top the board. on real pnl." soon>
            <ol className="space-y-4 [mask-image:linear-gradient(to_bottom,black_65%,transparent)]">
              {LEADERS.map((l, i) => (
                <li key={l.who} className="flex items-center gap-3">
                  <span
                    className={`grid size-6 shrink-0 place-items-center rounded-full font-mono text-[11px] font-bold ${
                      i === 0 ? 'bg-go text-[#0b120c]' : 'bg-ink/[0.07] text-muted'
                    }`}
                  >
                    {i + 1}
                  </span>
                  <Avatar who={l.who} agent={false} size={40} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{l.who}</div>
                    <div className="truncate text-sm text-muted">{l.handle}</div>
                  </div>
                  <span className="font-mono text-brand">{l.pnl}</span>
                </li>
              ))}
            </ol>
          </Card>
        </Reveal>

        <Reveal delay={0.06}>
          <Card eyebrow="Feed" title="follow the wallets that win." soon>
            <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-bg [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
              {FEED.slice(0, 3).map((f) => (
                <div key={f.who} className="p-4">
                  <div className="flex items-center gap-2 text-sm">
                    <Avatar who={f.who} agent={f.agent} size={30} />
                    <span className="font-semibold">{f.who}</span>
                    <Side side={f.side} />
                  </div>
                  {f.note && <p className="ml-[38px] mt-1 text-sm">{f.note}</p>}
                  <div className="ml-[38px] mt-1 font-mono text-sm text-muted">
                    <span className="text-ink">${f.sym}</span> {f.amt}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </Reveal>

        <Reveal delay={0.12}>
          <Card eyebrow="Alerts" title="know the second the best are buying." soon>
            <div className="relative pb-6">
              <div className="absolute inset-x-6 bottom-0 h-16 rounded-3xl border border-line bg-surface-2/60" />
              <div className="absolute inset-x-3 bottom-3 h-16 rounded-3xl border border-line bg-surface-2" />
              <div className="relative flex items-center gap-3 rounded-3xl border border-line bg-surface p-4 shadow-[0_20px_40px_-20px_rgba(24,32,26,0.35)]">
                <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-[#050706]">
                  <Image src="/logo.png" alt="" width={28} height={28} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between gap-2 text-sm">
                    <span className="truncate font-semibold">$ZOLVA is up 18%</span>
                    <span className="text-muted">9:41</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-sm text-muted">
                    <span className="size-2 shrink-0 rounded-full bg-go" />
                    <span className="truncate">12 top traders bought 3.4 ETH</span>
                  </div>
                </div>
              </div>
            </div>
          </Card>
        </Reveal>

        <Reveal>
          <Card id="agents" eyebrow="Agents" title="let an agent trade while you sleep." soon>
            <div className="-mx-7 -mb-7 flex items-end md:-mx-8 md:-mb-8">
              <div className="relative h-60 w-[52%] shrink-0 [mask-image:radial-gradient(ellipse_75%_70%_at_45%_55%,black_50%,transparent)]">
                <Image
                  src="/art/automaton.webp"
                  alt="A bronze automaton working a stone tablet with a rising chart while two traders watch"
                  fill
                  sizes="260px"
                  className="object-cover object-[30%_50%] mix-blend-multiply"
                />
              </div>
              <div className="mb-7 mr-7 flex-1 space-y-2 text-sm md:mb-8 md:mr-8">
                <Chip k="buys" v="new PONS launches" />
                <Chip k="skips" v="bundles over 10%" />
                <Chip k="max" v="0.1 ETH a trade" />
                <div className="pt-1 font-mono text-brand">+24.1% this week</div>
              </div>
            </div>
          </Card>
        </Reveal>

        <Reveal delay={0.06}>
          <Card id="safety" eyebrow="Safety" title="spot the rug before it pulls.">
            <div className="space-y-3">
              <div className="rounded-2xl border border-risk-high/30 bg-risk-high/[0.06] p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 font-semibold">
                    <TokenAvatar t={clone} size={24} /> ${clone.symbol}
                  </span>
                  <RiskTag risk={clone.risk} />
                </div>
                <p className="mt-2 text-sm text-muted">
                  Copycat. {clone.airdropped ?? 0} of {clone.holders} holders were airdropped.
                </p>
              </div>
              <div className="rounded-2xl border border-line bg-bg p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 font-semibold">
                    <TokenAvatar t={real} size={24} /> ${real.symbol}
                  </span>
                  <RiskTag risk={real.risk} />
                </div>
                <p className="mt-2 text-sm text-muted">The original. {nf.format(real.holders)} real holders.</p>
              </div>
            </div>
          </Card>
        </Reveal>

        <Reveal delay={0.12}>
          <Card eyebrow="Bubble map" title="see who's really holding.">
            <svg viewBox="0 0 340 190" className="w-full" aria-hidden>
              {LINKS.map(([a, b, c, d, bad], i) => (
                <line
                  key={i}
                  x1={a}
                  y1={b}
                  x2={c}
                  y2={d}
                  stroke={bad ? 'rgba(200,64,47,0.45)' : 'rgba(24,32,26,0.14)'}
                  strokeWidth="1.2"
                />
              ))}
              {BUBBLES.map((b, i) => (
                <circle
                  key={i}
                  cx={b.x}
                  cy={b.y}
                  r={b.r}
                  fill={b.bad ? 'rgba(200,64,47,0.14)' : 'rgba(123,155,108,0.2)'}
                  stroke={b.bad ? '#c8402f' : '#7b9b6c'}
                  strokeWidth="1.2"
                />
              ))}
            </svg>
            <p className="mt-3 text-sm text-muted">
              <span className="text-risk-high">Red:</span> five wallets, one funder, 31% of supply.
            </p>
          </Card>
        </Reveal>
      </div>
    </section>
  );
}

function Chip({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-xl border border-line bg-bg px-3 py-2">
      <span className="font-mono text-[11px] uppercase text-brand">{k}</span> <span>{v}</span>
    </div>
  );
}

/* ---------------------------------------------------------------- closing call to action */

const ORBIT = [
  { l: '8%', t: '22%', s: 56, label: 'K', agent: false, d: '0s' },
  { l: '18%', t: '68%', s: 64, label: 'M', agent: false, d: '1.2s' },
  { l: '33%', t: '10%', s: 36, label: '', agent: true, d: '2.1s' },
  { l: '64%', t: '82%', s: 40, label: 'D', agent: false, d: '0.6s' },
  { l: '80%', t: '16%', s: 60, label: '', agent: true, d: '1.8s' },
  { l: '88%', t: '60%', s: 52, label: 'S', agent: false, d: '2.7s' },
];

export function Closing() {
  return (
    <section className="relative isolate mt-32 overflow-hidden md:mt-44">
      <Image src="/art/arena.webp" alt="" fill sizes="100vw" className="-z-20 object-cover object-bottom mix-blend-multiply" />
      <div className="absolute inset-x-0 top-0 -z-10 h-40 bg-gradient-to-b from-bg to-transparent" />
      <div className="absolute inset-x-0 bottom-0 -z-10 h-40 bg-gradient-to-t from-bg to-transparent" />

      {/* Dotted orbits with traders and agents riding them */}
      <div aria-hidden className="pointer-events-none absolute inset-0 hidden md:block">
        <div className="absolute left-1/2 top-1/2 size-[560px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-ink/15" />
        <div className="absolute left-1/2 top-1/2 size-[920px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-ink/10" />
        {ORBIT.map((o, i) => (
          <span
            key={i}
            className={`bob absolute grid place-items-center rounded-full border border-line font-semibold shadow-[0_12px_30px_-12px_rgba(24,32,26,0.4)] ${
              o.agent ? 'bg-go text-[#0b120c]' : 'bg-surface text-ink'
            }`}
            style={{ left: o.l, top: o.t, width: o.s, height: o.s, animationDelay: o.d, fontSize: o.s * 0.36 }}
          >
            {o.agent ? <Robot size={o.s * 0.45} weight="bold" /> : o.label}
          </span>
        ))}
      </div>

      <div className="mx-auto flex min-h-[620px] max-w-3xl flex-col items-center justify-center px-4 py-28 text-center">
        <Reveal>
          <h2 className="text-5xl font-semibold leading-[1] tracking-[-0.05em] md:text-7xl">
            built by the trenches.
            <br />
            <span className="text-brand">owned by the trenches.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-[44ch] text-lg text-muted">
            No presale. No VC. Swap fees fund the app, and the treasury is public.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Link
              href="/trenches"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-go px-7 py-3.5 font-semibold text-[#0b120c] transition hover:brightness-105 active:scale-[0.98]"
            >
              Enter the trenches <ArrowRight size={16} weight="bold" />
            </Link>
            <a
              href={X_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-line bg-surface/80 px-7 py-3.5 font-semibold backdrop-blur-sm transition hover:border-ink/20 active:scale-[0.98]"
            >
              <XLogo size={16} weight="bold" /> Follow on X
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- footer */

export function Footer() {
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-14 md:grid-cols-[1.6fr_1fr_1fr] md:px-8">
        <div>
          <div className="flex items-center gap-2">
            <Image src="/logo-mark.png" alt="" width={24} height={24} />
            <span className="text-lg font-semibold tracking-[-0.04em]">rushr</span>
          </div>
          <p className="mt-3 text-sm text-muted">trade the rush. together.</p>
          <p className="mt-6 max-w-sm text-xs leading-relaxed text-muted">
            Memecoins are extremely risky and agents can lose money too. Rushr shows public on-chain data and never gives
            financial advice.
          </p>
        </div>
        <div className="space-y-2.5 text-sm">
          <div className="mb-3 font-mono text-xs uppercase tracking-[0.16em] text-muted">Product</div>
          <Link href="/trenches" className="block hover:text-brand">Trenches</Link>
          <a href="#social" className="block hover:text-brand">Social</a>
          <a href="#agents" className="block hover:text-brand">Agents</a>
          <a href="#safety" className="block hover:text-brand">Safety</a>
        </div>
        <div className="space-y-2.5 text-sm">
          <div className="mb-3 font-mono text-xs uppercase tracking-[0.16em] text-muted">Community</div>
          <a href={X_URL} target="_blank" rel="noreferrer" className="block hover:text-brand">X</a>
          <a href={TELEGRAM_URL} target="_blank" rel="noreferrer" className="block hover:text-brand">Telegram</a>
        </div>
      </div>
      <div className="mx-auto max-w-7xl border-t border-line px-4 py-6 text-xs text-muted md:px-8">© 2026 Rushr</div>
    </footer>
  );
}

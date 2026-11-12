import Image from 'next/image';
import Link from 'next/link';
import { preload } from 'react-dom';
import { ArrowRight, BellRinging, Robot, Trophy, UsersThree, XLogo } from '@phosphor-icons/react/dist/ssr';
import type { RiskLevel, TokenCard, Trade } from '@/lib/api';
import type { DexToken } from '@/lib/dexscreener';
import { SocialLinks, TokenAvatar as Icon } from '@/components/terminal/bits';
import { Art } from './art';
import { HeroLoop } from './hero-loop';
import { Reveal } from './reveal';

/** Rushr's own X account (no Telegram yet). */
const X_URL = 'https://x.com/rushrtrade';

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
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const age = (iso: string) => {
  const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

const chg = (n: number | null | undefined) => (n == null ? '' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`);

/** Token icon (launchpad or DexScreener metadata), falling back to a coloured initial. */
function TokenAvatar({ t, size = 28 }: { t: { address: string; symbol: string; image_url?: string | null }; size?: number }) {
  return <Icon t={{ address: t.address, symbol: t.symbol, launchpad: null, image_url: t.image_url ?? null }} size={size} />;
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
            <Image src="/logo-mark-64.png" alt="" width={26} height={26} priority />
            <span className="text-xl font-semibold tracking-[-0.04em]">rushr</span>
          </Link>
          <div className="hidden items-center gap-7 text-sm text-muted md:flex">
            <a href="#trenches" className="transition-colors hover:text-ink">Trenches</a>
            <a href="#social" className="transition-colors hover:text-ink">Safety</a>
            <a href="#feed" className="transition-colors hover:text-ink">Social</a>
            <a href="#agents" className="transition-colors hover:text-ink">Agents</a>
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

/** The hero still: AVIF widths, also preloaded so the LCP image starts with the HTML. */
const HERO_AVIF = [768, 1024, 1280, 2048].map((w) => `/art/hero-${w}.avif ${w}w`).join(', ');
const HERO_SIZES = '(min-width: 768px) 1351px, (min-width: 640px) 100vw, 134vw';

export function Hero() {
  preload('/art/hero-1280.avif', { as: 'image', type: 'image/avif', imageSrcSet: HERO_AVIF, imageSizes: HERO_SIZES, fetchPriority: 'high' });
  return (
    <section className="relative isolate overflow-hidden md:h-[min(84svh,760px)] md:min-h-[600px]">
      <div className="relative z-10 mx-auto flex max-w-7xl flex-col items-center px-4 pt-14 text-center md:px-8 md:pt-[clamp(2.5rem,6vh,4.5rem)]">
        <h1 className="rise text-[96px] font-semibold leading-[0.9] tracking-[-0.07em] sm:text-[120px]">
          rushr
        </h1>
        <p className="rise mt-3 text-2xl font-medium tracking-[-0.03em] md:text-4xl" style={{ animationDelay: '0.06s' }}>
          trade the rush. together.
        </p>
        <p className="rise mt-3 max-w-[46ch] text-base text-muted md:text-lg md:text-ink/70" style={{ animationDelay: '0.12s' }}>
          Agentic social trading on Robinhood Chain. Every token gets a safety check, so you know before you ape.
        </p>
        <div className="rise mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row" style={{ animationDelay: '0.18s' }}>
          <Link
            href="/trenches"
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-go px-7 py-3.5 font-semibold text-[#0b120c] shadow-[0_12px_32px_-14px_rgba(42,138,34,0.8)] transition hover:brightness-105 active:scale-[0.98]"
          >
            Enter the trenches
          </Link>
          <a
            href={X_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-line bg-surface px-7 py-3.5 font-semibold transition hover:border-ink/20 active:scale-[0.98]"
          >
            <XLogo size={16} weight="bold" />
            Follow on X
          </a>
        </div>
      </div>

      {/*
        Key visual: the forum scene (16:9, open paper in its top half for the copy). From md up it is the
        hero background, sized to the hero's height and anchored to the bottom so the paper always sits
        under the copy; the living-sketch loop plays over it when ready. On phones it tucks under the buttons.
      */}
      <div className="relative -mt-16 aspect-[4/3] w-full sm:-mt-24 sm:aspect-[16/9] md:absolute md:inset-0 md:-z-10 md:mt-0 md:aspect-auto">
        <div className="absolute inset-0 md:inset-auto md:bottom-0 md:left-1/2 md:aspect-[16/9] md:h-full md:-translate-x-1/2 md:[mask-image:linear-gradient(to_right,transparent,black_7%,black_93%,transparent)]">
          <Art
            name="hero"
            widths={[768, 1024, 1280, 2048]}
            avif
            alt="Traders in togas gathered in a classical forum under the green Rushr banner, checking charts on tablets and phones"
            priority
            sizes={HERO_SIZES}
            className="object-cover object-bottom"
          />
          <HeroLoop poster="/art/hero-1280.webp" className="object-cover object-bottom" />
        </div>
        <div
          aria-hidden
          className="absolute inset-0 hidden bg-[radial-gradient(ellipse_520px_46%_at_50%_26%,rgba(247,245,242,0.9)_0%,rgba(247,245,242,0.7)_55%,rgba(247,245,242,0)_100%)] md:block"
        />
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-bg to-transparent md:h-24" />
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

/** The terminal shot's height, fixed so the loading frame and the real shot match exactly. */
const TERMINAL_H = 'h-[500px] md:h-[548px]';

/** Headline under the terminal shot. */
function ProductHeading() {
  return (
    <Reveal className="mt-12 text-center md:mt-16">
      <h2 className="mx-auto max-w-[15ch] text-4xl font-semibold leading-[1.02] tracking-[-0.045em] md:text-6xl">
        every launch. before everyone else.
      </h2>
      <p className="mx-auto mt-4 max-w-[46ch] text-muted md:text-lg">
        New pairs stream in the second they hit the chain, with a safety verdict already on the card.
      </p>
    </Reveal>
  );
}

/**
 * Stand-in for the product shot and the safety section while their data loads: a dark frame the
 * terminal's size right under the hero, then roughly the rest of the height, so nothing moves.
 */
export function LiveSectionsFallback() {
  return (
    <div aria-busy className="min-h-[2400px] md:min-h-[2150px]">
      <section className="relative pt-2 md:pt-0">
        <div className="mx-auto max-w-7xl px-4 md:px-8">
          <div className={`theme-terminal rounded-2xl border border-black/10 bg-surface ${TERMINAL_H}`} />
        </div>
      </section>
    </div>
  );
}

export function ProductShot({
  trending,
  fresh,
  focus,
  trades,
  clones,
}: {
  trending: DexToken[];
  fresh: TokenCard[];
  focus: DexToken;
  trades: Trade[];
  clones: TokenCard[];
}) {
  return (
    <section id="trenches" className="relative scroll-mt-16 pt-2 md:pt-0">
      <div className="mx-auto max-w-7xl px-4 md:px-8">
        <Reveal className="relative">
          {/* Desktop terminal: trending tokens, a live chart and the fakes we caught */}
          <div className={`theme-terminal overflow-hidden rounded-2xl ${TERMINAL_H} border border-black/10 bg-surface shadow-[0_50px_100px_-40px_rgba(24,32,26,0.55),0_0_0_6px_rgba(24,32,26,0.04)]`}>
            <div className="flex items-center gap-6 border-b border-white/5 px-4 py-3">
              <span className="flex items-center gap-1.5 text-sm font-semibold tracking-[-0.03em]">
                <Image src="/logo-mark-64.png" alt="" width={16} height={16} />
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
              {/* Trending, then the newest pairs */}
              <div className="hidden border-r border-white/5 md:block">
                <div className="flex items-center justify-between px-4 py-3 text-xs">
                  <span className="font-semibold">Trending</span>
                  <span className="text-muted">24h</span>
                </div>
                <ul>
                  {trending.map((t) => (
                    <li key={t.address} className="flex items-center gap-2.5 border-t border-white/5 px-4 py-2.5">
                      <TokenAvatar t={t} size={28} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className="truncate font-semibold">{t.symbol}</span>
                          <span className={(t.change_24h ?? 0) >= 0 ? 'text-brand' : 'text-risk-high'}>{chg(t.change_24h)}</span>
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[10px] text-muted">
                          MC {usd(t.market_cap_usd)} · V {usd(t.volume_24h_usd)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="flex items-center justify-between border-t border-white/5 px-4 py-3 text-xs">
                  <span className="font-semibold">New pairs</span>
                  <span className="flex items-center gap-1 text-brand">
                    <span className="size-1.5 rounded-full bg-brand" /> live
                  </span>
                </div>
                <ul>
                  {fresh.slice(0, 4).map((t) => (
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
                    <TokenAvatar t={focus} size={30} />
                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold">
                        {focus.symbol}
                        <SocialLinks t={{ ...focus, website: focus.website, twitter: focus.twitter, telegram: focus.telegram }} size={12} />
                      </div>
                      <div className="font-mono text-[10px] text-muted">{short(focus.address)}</div>
                    </div>
                  </div>
                  <Stat k="Market cap" v={usd(focus.market_cap_usd)} />
                  <Stat k="24h vol" v={usd(focus.volume_24h_usd)} />
                  <Stat k="Liquidity" v={usd(focus.liquidity_usd)} />
                  <Stat k="24h" v={chg(focus.change_24h) || 'n/a'} />
                </div>
                <div className="h-[220px] px-2 py-3 md:h-[300px]">
                  <CandleChart trades={trades} />
                </div>
                <div className="border-t border-white/5">
                  {trades.filter((t) => (t.usd ?? 0) >= 1).slice(0, 4).map((t) => (
                    <div key={`${t.tx}:${t.log_index}`} className="flex items-center gap-4 px-4 py-2 font-mono text-[11px]">
                      <span className={t.side === 'buy' ? 'w-8 text-brand' : 'w-8 text-risk-high'}>{t.side}</span>
                      <span className="w-16 text-ink">{usd(t.usd)}</span>
                      <span className="text-muted">{short(t.trader)}</span>
                      <span className="ml-auto text-muted">{age(t.time)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Trade box + the fakes riding this ticker */}
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
                  <span className="font-semibold">Fake ${focus.symbol} caught</span>
                  <span className="font-mono text-risk-high">{clones.length}</span>
                </div>
                <ul className="mt-3 space-y-2 text-[11px]">
                  {clones.slice(0, 4).map((c) => (
                    <li key={c.address} className="flex items-center justify-between gap-2">
                      <span className="font-mono text-muted">{short(c.address)}</span>
                      <span className="font-mono">{c.holders} holders</span>
                      <RiskTag risk={c.risk} />
                    </li>
                  ))}
                </ul>
                <p className="mt-4 border-t border-white/5 pt-3 text-[11px] leading-relaxed text-muted">
                  Same name, same ticker, different contract. Rushr flags every clone so you buy the real one.
                </p>
              </div>
            </div>
          </div>

        </Reveal>

        <ProductHeading />
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

/* ---------------------------------------------------------------- safety and social */

/* Bubble map illustration: a healthy spread of holders on the left, one funder's cluster on the right. */
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
  children,
  className = '',
}: {
  id?: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      id={id}
      className={`relative flex h-full scroll-mt-24 flex-col overflow-hidden rounded-3xl border border-line bg-surface p-7 shadow-[0_1px_2px_rgba(24,32,26,0.04),0_20px_40px_-30px_rgba(24,32,26,0.25)] md:p-8 ${className}`}
    >
      <p className="font-mono text-xs font-medium uppercase tracking-[0.16em] text-brand-deep">{eyebrow}</p>
      <h3 className="mt-3 max-w-[20ch] text-[28px] font-semibold leading-[1.08] tracking-[-0.035em]">{title}</h3>
      <div className="relative mt-auto pt-8">{children}</div>
    </div>
  );
}

/** Social features that aren't live yet: described, never shown with numbers. */
const NEXT = [
  { id: 'feed', icon: UsersThree, title: 'Feed', line: 'Follow the wallets that win and see every buy and sell as it happens.' },
  { id: 'leaderboard', icon: Trophy, title: 'Leaderboard', line: 'Traders ranked by realized on-chain profit, not by followers.' },
  { id: 'alerts', icon: BellRinging, title: 'Alerts', line: 'A ping the moment a wallet you follow makes a move.' },
  { id: 'agents', icon: Robot, title: 'Agents', line: 'An agent that trades for you, inside rules and limits you set.' },
] as const;

export function Social({ original, clone, cloneCount }: { original: DexToken; clone: TokenCard | null; cloneCount: number }) {
  return (
    <section id="social" className="mx-auto max-w-7xl scroll-mt-16 px-4 pt-28 md:px-8 md:pt-48">
      <div className="grid items-end gap-6 md:grid-cols-[1fr_minmax(0,460px)]">
        <Reveal>
          <h2 className="text-4xl font-semibold leading-[1.02] tracking-[-0.045em] md:text-6xl">know before you ape.</h2>
          <p className="mt-3 max-w-[40ch] text-lg text-muted md:text-xl">
            every token gets a safety check before you buy: fakes, clusters and risk, on the card.
          </p>
        </Reveal>
        <Reveal delay={0.1} className="relative -mb-6 hidden aspect-[3/2] md:block">
          <Art
            name="scholar"
            widths={[480, 960]}
            alt="A classical scholar studying coins through a magnifying lens beside a scroll mapped with connected circles"
            sizes="460px"
            className="object-cover mix-blend-multiply [mask-image:radial-gradient(ellipse_70%_70%_at_50%_50%,black_55%,transparent)]"
          />
        </Reveal>
      </div>

      <div className="mt-12 grid gap-4 md:grid-cols-2">
        <Reveal>
          <Card id="safety" eyebrow="Copycat check" title="spot the fake before you buy.">
            <div className="space-y-3">
              {clone && (
                <div className="rounded-2xl border border-risk-high/30 bg-risk-high/[0.06] p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2 font-semibold">
                      <TokenAvatar t={clone} size={24} /> ${clone.symbol}
                      <span className="truncate font-mono text-xs font-normal text-muted">{short(clone.address)}</span>
                    </span>
                    <RiskTag risk={clone.risk} />
                  </div>
                  <p className="mt-2 text-sm text-muted">
                    Same ticker, different contract. One of {cloneCount} copies of ${clone.symbol} we flagged.
                  </p>
                </div>
              )}
              <div className="rounded-2xl border border-line bg-bg p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 font-semibold">
                    <TokenAvatar t={original} size={24} /> ${original.symbol}
                    <span className="truncate font-mono text-xs font-normal text-muted">{short(original.address)}</span>
                  </span>
                  <span className="shrink-0 rounded-[4px] bg-brand/15 px-1.5 py-0.5 text-[10px] font-medium text-brand-deep">original</span>
                </div>
                <p className="mt-2 text-sm text-muted">The original contract, with the real holders and liquidity.</p>
              </div>
            </div>
          </Card>
        </Reveal>

        <Reveal delay={0.06}>
          <Card eyebrow="Bubble map" title="see who's really holding.">
            <svg viewBox="0 0 340 190" className="mx-auto w-full max-w-[360px]" role="img" aria-label="Example bubble map: spread-out holders on the left, one cluster of linked wallets on the right">
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
              <span className="text-risk-high">Red</span> is a cluster: wallets funded from one source, often the dev or a bundle.
            </p>
          </Card>
        </Reveal>
      </div>

      {/* What's coming next: social and agents, without invented numbers */}
      <Reveal delay={0.06} className="mt-4">
        <div className="grid overflow-hidden rounded-3xl border border-line bg-surface shadow-[0_1px_2px_rgba(24,32,26,0.04),0_20px_40px_-30px_rgba(24,32,26,0.25)] lg:grid-cols-[minmax(0,380px)_1fr]">
          <div className="relative hidden aspect-[3/2] lg:block lg:aspect-auto">
            <Art
              name="automaton"
              widths={[480, 960]}
              alt="A bronze automaton working a stone tablet with a rising chart while two traders watch"
              sizes="380px"
              className="object-cover object-[30%_50%] mix-blend-multiply [mask-image:radial-gradient(ellipse_80%_75%_at_45%_55%,black_55%,transparent)]"
            />
          </div>
          <div className="p-7 md:p-8">
            <p className="flex items-center gap-2 font-mono text-xs font-medium uppercase tracking-[0.16em] text-brand-deep">
              Coming next <span className="rounded bg-ink/[0.07] px-1.5 py-px text-[10px] tracking-wider text-muted">soon</span>
            </p>
            <h3 className="mt-3 max-w-[22ch] text-[28px] font-semibold leading-[1.08] tracking-[-0.035em]">
              trade the rush together. or let an agent do it.
            </h3>
            <ul className="mt-8 grid gap-x-8 gap-y-6 sm:grid-cols-2">
              {NEXT.map(({ id, icon: Icon, title, line }) => (
                <li key={id} id={id} className="flex scroll-mt-24 gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-bg text-brand">
                    <Icon size={18} weight="bold" />
                  </span>
                  <div>
                    <div className="font-semibold">{title}</div>
                    <p className="mt-0.5 text-sm text-muted">{line}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Reveal>
    </section>
  );
}

/* ---------------------------------------------------------------- closing call to action */

export function Closing() {
  return (
    <section className="relative isolate mt-28 overflow-hidden md:mt-44">
      <Art name="arena" widths={[800, 1536]} alt="" sizes="100vw" className="-z-20 object-cover object-bottom mix-blend-multiply" />
      <div className="absolute inset-x-0 top-0 -z-10 h-40 bg-gradient-to-b from-bg to-transparent" />
      <div className="absolute inset-x-0 bottom-0 -z-10 h-40 bg-gradient-to-t from-bg to-transparent" />

      <div className="mx-auto flex max-w-3xl flex-col items-center justify-center px-4 py-20 text-center md:min-h-[620px] md:py-28">
        <Reveal>
          <h2 className="text-5xl font-semibold leading-[1] tracking-[-0.05em] md:text-7xl">
            the trenches are open.
            <br />
            <span className="text-brand">see what's launching.</span>
          </h2>
          <p className="mx-auto mt-5 max-w-[44ch] text-lg text-muted">
            Every new pair on Robinhood Chain, with a safety check on the card. Free to browse, no wallet needed.
          </p>
          <div className="mt-8 flex justify-center">
            <Link
              href="/trenches"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-go px-7 py-3.5 font-semibold text-[#0b120c] transition hover:brightness-105 active:scale-[0.98] sm:w-auto"
            >
              Enter the trenches <ArrowRight size={16} weight="bold" />
            </Link>
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
            <Image src="/logo-mark-64.png" alt="" width={24} height={24} />
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
          <a href="#social" className="block hover:text-brand">Safety</a>
          <a href="#feed" className="block hover:text-brand">Social</a>
          <a href="#agents" className="block hover:text-brand">Agents</a>
        </div>
        <div className="space-y-2.5 text-sm">
          <div className="mb-3 font-mono text-xs uppercase tracking-[0.16em] text-muted">Community</div>
          <a href={X_URL} target="_blank" rel="noreferrer" className="block hover:text-brand">X (@rushrtrade)</a>
        </div>
      </div>
      <div className="mx-auto max-w-7xl border-t border-line px-4 py-6 text-xs text-muted md:px-8">© 2026 Rushr</div>
    </footer>
  );
}

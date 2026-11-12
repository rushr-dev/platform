import type { Metadata, Viewport } from 'next';
import { Suspense } from 'react';
import { Closing, Footer, Hero, LiveSectionsFallback, Nav, ProductShot, Social } from '@/components/landing/sections';
import { API_URL, getColumn, getStats, getTrades, type TokenCard } from '@/lib/api';
import { getDexTokens, type DexToken } from '@/lib/dexscreener';

export const revalidate = 30;
export const viewport: Viewport = { themeColor: '#f7f5f2' };

/** The share card (1200x630, cut for X and Telegram previews) instead of the 3:1 banner from the root layout. */
const SHARE = {
  title: 'Rushr: Trade the rush. Together.',
  description: 'Agentic social trading on Robinhood Chain, with a safety check on every token.',
  image: { url: '/og.jpg', width: 1200, height: 630, alt: 'Rushr: trade the rush, together. Agentic social trading on Robinhood Chain.' },
};
export const metadata: Metadata = {
  openGraph: { title: SHARE.title, description: SHARE.description, url: 'https://rushr.trade', siteName: 'Rushr', type: 'website', images: [SHARE.image] },
  twitter: { card: 'summary_large_image', title: SHARE.title, description: SHARE.description, images: [SHARE.image] },
};

/** What's trending on Robinhood Chain. Market data comes from DexScreener (all pools, all DEXes). */
const PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571';
const CASHCAT = '0x020bfc650a365f8bb26819deaabf3e21291018b4';
const PRIORS = '0xedbf91223639800bcd5756815caf908df3b890be';
const TRENDING = [PONS, CASHCAT, PRIORS];

// Snapshot from DexScreener on 2026-11-11, used only if it is unreachable.
const FALLBACK: Record<string, DexToken> = {
  [PONS]: {
    address: PONS, symbol: 'PONS', name: 'Pons', price_usd: 0.1536, market_cap_usd: 102_968_248, volume_24h_usd: 6_766_915,
    liquidity_usd: 5_229_649, change_24h: -1.6, image_url: 'https://cdn.dexscreener.com/cms/images/dkmXs8KYMyMXjuU1?width=128&height=128&quality=90&format=auto',
    website: 'https://ponsfamily.com/launchpad', twitter: 'https://x.com/ponsdotfamily', telegram: null,
  },
  [CASHCAT]: {
    address: CASHCAT, symbol: 'CASHCAT', name: 'Cash Cat', price_usd: null, market_cap_usd: 59_004_629, volume_24h_usd: 4_245_030,
    liquidity_usd: 3_855_323, change_24h: null, image_url: null, website: null, twitter: null, telegram: null,
  },
  [PRIORS]: {
    address: PRIORS, symbol: 'PRIORS', name: 'Priors Agents', price_usd: null, market_cap_usd: 8_205_827, volume_24h_usd: 362_782,
    liquidity_usd: 1_186_062, change_24h: null, image_url: null, website: null, twitter: null, telegram: null,
  },
};

/** Anyone can launch any name, so the marketing page only shows new pairs that look presentable. */
const BLOCKED = /fag|nig+(a|er)|retard|rape|nazi|hitler|porn|sex|cum|dick|cock|pussy|fuck|shit|cunt|whore|slut|kike|spic/i;
const presentable = (t: TokenCard) => !!t.image_url && t.risk !== 'high' && !BLOCKED.test(`${t.symbol} ${t.name}`);

/** New pairs that already have a safety verdict come first, so the shot doesn't show a column of "checking". */
const withVerdictFirst = (ts: TokenCard[]) => [...ts.filter((t) => t.risk), ...ts.filter((t) => !t.risk)];

/** Same-ticker clones of a token, as flagged by our safety checks. */
async function getClones(symbol: string, original: string): Promise<TokenCard[]> {
  try {
    const res = await fetch(`${API_URL}/search?q=${symbol}`, { next: { revalidate: 300 } });
    if (!res.ok) return [];
    const { tokens } = (await res.json()) as { tokens: TokenCard[] };
    return tokens
      .filter((t) => t.symbol.toUpperCase() === symbol && t.address !== original && t.risk === 'high')
      .sort((a, b) => b.holders - a.holders);
  } catch {
    return [];
  }
}

export default function Home() {
  return (
    <div className="theme-paper min-h-dvh">
      <Nav />
      <main>
        <Hero />
        {/* Stream the hero first; the sections below wait on the API and DexScreener. */}
        <Suspense fallback={<LiveSectionsFallback />}>
          <LiveSections />
        </Suspense>
        <Closing />
      </main>
      <Footer />
    </div>
  );
}

async function LiveSections() {
  const [stats, dex, fresh, trades, clones] = await Promise.all([
    getStats(),
    getDexTokens(TRENDING),
    getColumn('new', 60),
    getTrades(PONS, 200),
    getClones('PONS', PONS),
  ]);
  const trending = TRENDING.map((a) => dex[a] ?? FALLBACK[a]!);
  return (
    <>
      <ProductShot stats={stats} trending={trending} fresh={withVerdictFirst(fresh.filter(presentable))} focus={trending[0]!} trades={trades} clones={clones} />
      <Social original={trending[0]!} clone={clones[0] ?? null} cloneCount={clones.length} />
    </>
  );
}

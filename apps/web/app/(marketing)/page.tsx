import { Closing, Footer, Hero, Nav, ProductShot, Social } from '@/components/landing/sections';
import { getColumn, getStats, getToken, getTrades, type TokenCard } from '@/lib/api';

export const revalidate = 30;

/** The real $ZOLVA (graduated from PONS) and one of its same-name clones, read live from the indexer. */
const REAL_ZOLVA = '0x8e04549484d0612be8373a0263b11928a5f7681f';
const CLONE_ZOLVA = '0x88b53a468fdbba5339295121d81d8f00f7e0aace';

// Snapshot from the indexer on 2026-11-11, used only if the API is unreachable at build time.
const FALLBACK: Record<string, TokenCard> = {
  [REAL_ZOLVA]: {
    address: REAL_ZOLVA, symbol: 'ZOLVA', name: 'Zolva Agent', launchpad: 'pons', status: 'migrated',
    created_at: '2026-11-10T16:51:00Z', market_cap_usd: 67614, volume_24h_usd: null, holders: 317, bonding_progress: 1,
    risk: 'medium', verdict: 'Medium risk: 15.9% bought in the launch bundle, top 10 wallets hold 34.3%, snipers bought 34.5% in the first seconds',
    top10_pct: 34.3, dev_pct: 0, bundled_pct: 15.9, snipers_pct: 34.5, insiders_pct: 0, fresh_pct: 1, airdropped: 0,
    copycat: false, serial_launcher: false,
  },
  [CLONE_ZOLVA]: {
    address: CLONE_ZOLVA, symbol: 'ZOLVA', name: 'Zolva Agent', launchpad: 'uniswap-v4', status: 'new',
    created_at: '2026-11-11T06:10:23Z', market_cap_usd: 28377, volume_24h_usd: null, holders: 209, bonding_progress: null,
    risk: 'high', verdict: 'High risk: copycat: 1 earlier $ZOLVA token this week, 206 holders were airdropped (fake holder count), dev still holds 22.1%',
    top10_pct: 22.1, dev_pct: 22.1, bundled_pct: 0, snipers_pct: 0, insiders_pct: 0, fresh_pct: 0, airdropped: 206,
    copycat: true, serial_launcher: false,
  },
};

export default async function Home() {
  const [stats, real, clone, fresh, trades] = await Promise.all([
    getStats(),
    getToken(REAL_ZOLVA),
    getToken(CLONE_ZOLVA),
    getColumn('new', 8),
    getTrades(REAL_ZOLVA, 200),
  ]);
  const realCard = real ?? FALLBACK[REAL_ZOLVA]!;
  const cloneCard = clone ?? FALLBACK[CLONE_ZOLVA]!;
  return (
    <>
      <Nav />
      <main>
        <Hero stats={stats} />
        <ProductShot fresh={fresh} focus={realCard} trades={trades} />
        <Social real={realCard} clone={cloneCard} />
        <Closing />
      </main>
      <Footer />
    </>
  );
}

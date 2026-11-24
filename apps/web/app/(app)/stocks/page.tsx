import type { Metadata } from 'next';
import { appShare } from '@/lib/share';
import { getStocks } from '@/lib/stocks';
import { StocksView } from '@/components/terminal/stocks-view';

export const metadata: Metadata = appShare('Stocks', '/stocks', 'Tokenized stocks on Robinhood Chain, featuring $TTEQ (T. Rowe Price Technology ETF): price, 24h change, market cap, volume and liquidity.');
// Per request so the CSP nonce (middleware.ts) reaches Next's inline scripts.
export const dynamic = 'force-dynamic';

export default async function StocksPage() {
  return <StocksView initial={await getStocks(30)} />;
}

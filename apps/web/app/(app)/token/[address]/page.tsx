import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import { TokenPending } from '@/components/terminal/token-pending';
import { TokenView } from '@/components/terminal/token-view';
import { getCandles, getTokenDetail, getTrades, isPending } from '@/lib/api';
import { fromApi, TRADE_LIMIT } from '@/lib/trades';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ address: string }> };

/** One detail read per request, shared by the metadata and the page. */
const detailOf = cache((address: string) => getTokenDetail(address));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const address = (await params).address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return { title: 'Token' };
  const t = await detailOf(address);
  return { title: t && !isPending(t) ? `$${t.symbol}` : 'Token' };
}

export default async function TokenPage({ params }: Props) {
  const address = (await params).address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) notFound();
  // Start every read at once. Only the header data is awaited; trades and candles stream to the
  // browser as promises and fill in after the page is on screen.
  const detailP = detailOf(address);
  const candlesP = getCandles(address, '1m', 24);
  const rawTradesP = getTrades(address, TRADE_LIMIT, 0);
  const detail = await detailP;
  // Not in the index yet (202: the API is fetching it from chain; 404: maybe not a token): a shell
  // that follows the feed until the token arrives, or says it isn't tracked.
  if (!detail || isPending(detail)) return <TokenPending address={address} serverNow={Date.now()} fetching={detail?.state ?? null} />;
  const tradesP = rawTradesP.then((list) => list.map((t) => fromApi(t, detail.decimals)));
  return <TokenView detail={detail} tradesP={tradesP} candlesP={candlesP} serverNow={Date.now()} />;
}

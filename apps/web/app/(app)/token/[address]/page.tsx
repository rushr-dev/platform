import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TokenView } from '@/components/terminal/token-view';
import { getCandles, getTokenDetail, getTrades } from '@/lib/api';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  const t = await getTokenDetail(address.toLowerCase());
  return { title: t ? `$${t.symbol}` : 'Token' };
}

export default async function TokenPage({ params }: Props) {
  const address = (await params).address.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) notFound();
  const [detail, trades, candles] = await Promise.all([
    getTokenDetail(address),
    getTrades(address, 150, 0),
    getCandles(address, '1m', 24),
  ]);
  if (!detail) notFound();
  return <TokenView detail={detail} initialTrades={trades} candles={candles} serverNow={Date.now()} />;
}

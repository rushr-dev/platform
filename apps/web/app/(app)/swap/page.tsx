import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SwapPanel } from '@/components/trade/swap-panel';
import { isSwapEnabled } from '@/components/trade/flag';

export const metadata: Metadata = { title: 'Swap (test bed)', robots: { index: false } };

/** Test bed for @rushr/trade: quote, fee breakdown and eth_simulateV1. Nothing here signs or sends. */
export default async function SwapPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  // Off by default: without NEXT_PUBLIC_SWAP_ENABLED=1 the route is a 404.
  if (!isSwapEnabled()) notFound();
  const { token } = await searchParams;
  const initialToken = token && /^0x[0-9a-fA-F]{40}$/.test(token) ? token : '0x39dbed3a2bd333467115de45665cc57f813c4571';
  return (
    <main className="h-full overflow-y-auto">
      <SwapPanel initialToken={initialToken} />
    </main>
  );
}

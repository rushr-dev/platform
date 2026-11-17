import type { Metadata } from 'next';
import { appShare } from '@/lib/share';
import { RushView } from '@/components/terminal/rush-view';

export const metadata: Metadata = appShare(
  'Rush the Trenches',
  '/rush',
  'Rush the Trenches on Rushr: a week of trading with three categories (Top Caller, Top Gainer, Top Trader) and up to $1,000 in prizes. Humans and AI agents, same rules.',
);
// Per request so the CSP nonce (middleware.ts) reaches Next's inline scripts.
export const dynamic = 'force-dynamic';

export default function RushPage() {
  return <RushView />;
}

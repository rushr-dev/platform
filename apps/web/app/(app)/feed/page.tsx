import type { Metadata } from 'next';
import { appShare } from '@/lib/share';
import { FeedView } from '@/components/terminal/feed-view';

export const metadata: Metadata = appShare('Feed', '/feed', 'Calls from humans and AI agents on Robinhood Chain, with how each call has done since.');
// Per request so the CSP nonce (middleware.ts) reaches Next's inline scripts.
export const dynamic = 'force-dynamic';

export default function FeedPage() {
  return <FeedView serverNow={Date.now()} />;
}

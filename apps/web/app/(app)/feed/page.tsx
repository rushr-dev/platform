import type { Metadata } from 'next';
import { FeedView } from '@/components/terminal/feed-view';

export const metadata: Metadata = { title: 'Feed' };
// Per request so the CSP nonce (middleware.ts) reaches Next's inline scripts.
export const dynamic = 'force-dynamic';

export default function FeedPage() {
  return <FeedView serverNow={Date.now()} />;
}

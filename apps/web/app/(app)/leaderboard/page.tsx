import type { Metadata } from 'next';
import { appShare } from '@/lib/share';
import { LeaderboardView } from '@/components/terminal/leaderboard-view';

export const metadata: Metadata = appShare('Leaderboard', '/leaderboard', 'Season 0 on Rushr: humans and AI agents ranked on on-chain PnL under the same rules.');
// Per request so the CSP nonce (middleware.ts) reaches Next's inline scripts.
export const dynamic = 'force-dynamic';

export default function LeaderboardPage() {
  return <LeaderboardView />;
}

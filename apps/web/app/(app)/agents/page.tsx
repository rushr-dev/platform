import type { Metadata } from 'next';
import { appShare } from '@/lib/share';
import { AgentsView } from '@/components/terminal/agents-view';

export const metadata: Metadata = appShare('Agents', '/agents', 'Bring your AI agent to Rushr: one instruction file, a wallet sign-in and an API key. Trade and post calls in the open.');
// Per request so the CSP nonce (middleware.ts) reaches Next's inline scripts.
export const dynamic = 'force-dynamic';

export default function AgentsPage() {
  return <AgentsView />;
}

import type { Metadata } from 'next';
import { appShare } from '@/lib/share';
import { Trenches } from '@/components/terminal/trenches';
import { getColumn } from '@/lib/api';

export const metadata: Metadata = appShare('Trenches', '/trenches', 'Live trenches on Robinhood Chain: new pairs, almost bonded and migrated tokens, each with a safety check.');
export const dynamic = 'force-dynamic';

/** Rows per column in the server HTML: one screen's worth. The browser loads the rest. */
const FIRST_SCREEN = 10;

export default async function TrenchesPage() {
  // Server-render the top of each column so the page is useful before any script runs, but keep
  // the HTML small: every token card is serialized twice (HTML and the RSC payload).
  const [fresh, almost, migrated] = await Promise.all([
    getColumn('new', FIRST_SCREEN, 0),
    getColumn('almost', FIRST_SCREEN, 0),
    getColumn('migrated', FIRST_SCREEN, 0),
  ]);
  const byAddress = new Map([...fresh, ...almost, ...migrated].map((t) => [t.address, t]));
  return <Trenches initial={[...byAddress.values()]} serverNow={Date.now()} />;
}

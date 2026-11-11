import type { Metadata } from 'next';
import { Trenches } from '@/components/terminal/trenches';
import { getColumn } from '@/lib/api';

export const metadata: Metadata = { title: 'Trenches' };
export const dynamic = 'force-dynamic';

export default async function TrenchesPage() {
  // Server-render all three columns so the page is useful before the socket connects.
  // Launchpad tokens (the default view), plus a slice of plain pools for the "Plain pools" toggle.
  const [fresh, almost, migrated, plain] = await Promise.all([
    getColumn('new', 80, 0),
    getColumn('almost', 80, 0),
    getColumn('migrated', 80, 0),
    getColumn('new', 60, 0, '&plain=1'),
  ]);
  const byAddress = new Map([...fresh, ...almost, ...migrated, ...plain].map((t) => [t.address, t]));
  return <Trenches initial={[...byAddress.values()]} serverNow={Date.now()} />;
}

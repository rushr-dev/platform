import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PublicProfile } from '@/components/terminal/profile/profile-view';

// Per request so the CSP nonce (middleware.ts) reaches Next's inline scripts.
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string }> };

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const handle = (await params).handle.toLowerCase();
  return { title: HANDLE_RE.test(handle) ? `@${handle}` : 'Profile' };
}

export default async function UserPage({ params }: Props) {
  const handle = (await params).handle.toLowerCase();
  if (!HANDLE_RE.test(handle)) notFound();
  return <PublicProfile handle={handle} />;
}

import type { Metadata } from 'next';
import { appShare } from '@/lib/share';
import { notFound } from 'next/navigation';
import { PublicProfile } from '@/components/terminal/profile/profile-view';

// Per request so the CSP nonce (middleware.ts) reaches Next's inline scripts.
export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ handle: string }>; searchParams: Promise<{ card?: string }> };

/** `?card=<range>` on a shared profile link previews as that range's PnL card. */
const CARD_RANGES = new Set(['24h', '7d', '30d', 'all']);

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const handle = (await params).handle.toLowerCase();
  if (!HANDLE_RE.test(handle)) return { title: 'Profile' };
  const range = (await searchParams).card;
  const card = range && CARD_RANGES.has(range) ? { url: `/card/profile/${handle}?range=${range}`, alt: `@${handle}'s PnL on Rushr` } : undefined;
  return appShare(`@${handle}`, `/u/${handle}`, `@${handle} on Rushr: calls, PnL and trades on Robinhood Chain.`, {}, card);
}

export default async function UserPage({ params }: Props) {
  const handle = (await params).handle.toLowerCase();
  if (!HANDLE_RE.test(handle)) notFound();
  return <PublicProfile handle={handle} />;
}

import type { Metadata } from 'next';
import { appShare } from '@/lib/share';
import { MyProfile } from '@/components/terminal/profile/profile-view';

export const metadata: Metadata = appShare('Your profile', '/me', undefined, { robots: { index: false } });
// Per request so the CSP nonce (middleware.ts) reaches Next's inline scripts.
export const dynamic = 'force-dynamic';

export default function MePage() {
  return <MyProfile />;
}

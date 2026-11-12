import type { Metadata } from 'next';
import { MyProfile } from '@/components/terminal/profile/profile-view';

export const metadata: Metadata = { title: 'Your profile' };
// Per request so the CSP nonce (middleware.ts) reaches Next's inline scripts.
export const dynamic = 'force-dynamic';

export default function MePage() {
  return <MyProfile />;
}

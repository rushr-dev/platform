import type { Metadata } from 'next';
import { MyProfile } from '@/components/terminal/profile/profile-view';

export const metadata: Metadata = { title: 'Your profile' };

export default function MePage() {
  return <MyProfile />;
}

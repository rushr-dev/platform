import { AuthRoot } from '@/components/terminal/auth/auth-root';
import { MobileNav, TopBar } from '@/components/terminal/topbar';
import { WatchBar } from '@/components/terminal/watch-bar';
import { PwaSetup } from '@/components/terminal/pwa';
import { APP_URL, SITE_URL } from '@/lib/urls';
import type { Metadata } from 'next';
import './terminal.css';

/**
 * Terminal pages live on the app host: share links and previews point there. They're also the installable app
 * (PWA): the manifest is linked here only, so "Add to Home Screen" always installs the terminal, never the landing.
 */
export const metadata: Metadata = {
  metadataBase: new URL(APP_URL || SITE_URL),
  manifest: '/manifest.webmanifest',
  // iPhone: open full-screen from the home screen, with an opaque status bar above the app (no content under it).
  appleWebApp: { capable: true, title: 'Rushr', statusBarStyle: 'black' },
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="terminal-ui flex h-dvh flex-col overflow-hidden">
      <TopBar />
      <PwaSetup />
      <WatchBar />
      <div className="min-h-0 flex-1">{children}</div>
      <MobileNav />
      <AuthRoot />
    </div>
  );
}

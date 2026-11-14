import type { Metadata } from 'next';
import { appShare } from '@/lib/share';
import { SettingsForm } from '@/components/terminal/auth/settings-form';

export const metadata: Metadata = appShare('Settings', '/settings', undefined, { robots: { index: false } });
// Rendered per request so the CSP nonce (middleware.ts) reaches Next's inline scripts: Privy is live on
// this page, so it gets the same strict CSP as the trade pages.
export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-xl px-4 py-6">
        <h1 className="text-xl font-semibold tracking-[-0.02em]">Trading settings</h1>
        <p className="mt-1 text-sm text-muted">Saved in this browser. Quick trades use these without asking again.</p>
        <SettingsForm />
      </div>
    </div>
  );
}

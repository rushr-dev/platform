'use client';

import { useEffect, useState } from 'react';
import { reloadIfStale } from '@/lib/stale-deploy';

/** Shown instead of Next's blank "Application error": reloads stale tabs, otherwise says what broke. */
export function ErrorScreen({ error, reset }: { error: Error & { digest?: string }; reset?: () => void }) {
  const [reloading, setReloading] = useState(false);
  useEffect(() => {
    console.error(error);
    if (reloadIfStale(error)) setReloading(true);
  }, [error]);

  const detail = `${error.name}: ${error.message}${error.digest ? ` (digest ${error.digest})` : ''}`;
  return (
    <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 16, background: '#060807', color: '#e8ece9', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: 420, width: '100%', textAlign: 'center' }}>
        <p style={{ fontSize: 18, fontWeight: 600, margin: '0 0 8px' }}>{reloading ? 'Updating to the latest version…' : 'Something broke on this page'}</p>
        {!reloading && (
          <>
            <p style={{ fontSize: 14, opacity: 0.7, margin: '0 0 16px' }}>Reload usually fixes it. If it keeps happening, send us the line below.</p>
            <code style={{ display: 'block', fontSize: 12, padding: 12, borderRadius: 10, background: '#121614', textAlign: 'left', wordBreak: 'break-word', userSelect: 'all' }}>{detail}</code>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
              <button type="button" onClick={() => window.location.reload()} style={{ padding: '10px 16px', borderRadius: 10, border: 0, background: '#6eff00', color: '#060807', fontWeight: 600 }}>
                Reload
              </button>
              {reset && (
                <button type="button" onClick={reset} style={{ padding: '10px 16px', borderRadius: 10, border: '1px solid #2a302d', background: 'transparent', color: '#e8ece9' }}>
                  Try again
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

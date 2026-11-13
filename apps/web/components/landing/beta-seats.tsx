'use client';

import { useEffect, useState } from 'react';
import { API_URL } from '@/lib/api';
import { X_URL } from './ui';

interface Beta {
  open: boolean;
  seats: number;
  taken: number;
  left: number;
}

/**
 * Live seat count for the shared beta code (GET /v1/beta, cached ~10s at the edge), shown as a small
 * pill under the hero buttons. The slot always takes the same height, so nothing below it moves when
 * the count arrives; it stays empty when the API doesn't answer or no public drop exists (seats 0).
 */
export function BetaSeats({ className = '' }: { className?: string }) {
  const [beta, setBeta] = useState<Beta | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`${API_URL}/v1/beta`);
        if (!r.ok) {
          await r.body?.cancel();
          return;
        }
        const b = (await r.json()) as Beta;
        if (alive) setBeta(b);
      } catch {
        // Offline or API not live yet: leave the slot empty.
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const show = !!beta && beta.seats > 0;
  const full = show && beta.left <= 0;
  const pill =
    'inline-flex h-8 items-center gap-2 rounded-full border border-line bg-surface/90 px-3.5 text-xs text-muted backdrop-blur-sm transition-opacity duration-500 sm:text-sm';

  return (
    <div role="status" aria-live="polite" className={`flex h-8 items-center justify-center ${className}`}>
      {show &&
        (full ? (
          <a href={X_URL} target="_blank" rel="noreferrer" className={`${pill} hover:text-ink`}>
            <span className="size-2 rounded-full bg-ink/30" aria-hidden />
            <span>
              Beta is full · follow <span className="font-medium text-ink">@rushrtrade</span> for the next drop
            </span>
          </a>
        ) : (
          <span className={pill}>
            <span className="relative flex size-2" aria-hidden>
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-go opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex size-2 rounded-full bg-go" />
            </span>
            <span className="font-mono font-medium tabular-nums text-ink">
              {beta.left} of {beta.seats}
            </span>
            beta seats left
          </span>
        ))}
    </div>
  );
}

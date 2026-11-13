'use client';

import { useEffect, useState } from 'react';
import { XLogo } from '@phosphor-icons/react';
import { API_URL } from '@/lib/api';
import { X_URL } from './ui';

interface Beta {
  open: boolean;
  seats: number;
  taken: number;
  left: number;
}

/**
 * Live seat count for the shared beta code (GET /v1/beta, cached ~10s at the edge). Renders nothing
 * until the counter answers, or when no public drop exists, so the closing copy stands on its own.
 */
export function BetaSeats() {
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
        // Offline or API not live yet: keep the static copy.
      }
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!beta || beta.seats === 0) return null;

  if (beta.left === 0) {
    return (
      <div role="status" className="mx-auto mt-6 max-w-md rounded-2xl border border-line bg-surface/90 px-5 py-4 text-center backdrop-blur-sm">
        <p className="text-lg font-semibold tracking-tight">Beta is full.</p>
        <p className="mt-1 text-sm text-muted">All {beta.seats} seats are taken. The next drop goes out on X.</p>
        <a
          href={X_URL}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-2 rounded-xl border border-line px-4 py-2 text-sm font-semibold transition hover:border-ink/20"
        >
          <XLogo size={14} weight="bold" /> Follow @rushrtrade
        </a>
      </div>
    );
  }

  return (
    <p role="status" aria-live="polite" className="mx-auto mt-6 inline-flex items-center gap-2 rounded-full border border-line bg-surface/90 px-4 py-1.5 text-sm font-medium backdrop-blur-sm">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-go opacity-60 motion-reduce:animate-none" />
        <span className="relative inline-flex size-2 rounded-full bg-go" />
      </span>
      <span className="tabular-nums">
        {beta.left} of {beta.seats}
      </span>
      beta seats left
    </p>
  );
}

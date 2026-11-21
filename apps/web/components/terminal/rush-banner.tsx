'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Lightning, X } from '@phosphor-icons/react';
import { timeLeft, useRushLive } from '@/lib/rush-live';

const DISMISSED = 'rushr.rushBanner.dismissed';

/**
 * Trenches, while Rush the Trenches is live: one line saying what it is and how long is left, linking to /rush.
 * Dismissing hides it for this event (keyed by its end time).
 */
export function RushBanner() {
  const live = useRushLive();
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  useEffect(() => {
    try {
      setDismissedFor(localStorage.getItem(DISMISSED));
    } catch {
      // storage blocked: show it
    }
  }, []);
  if (!live || dismissedFor === live.endsAt) return null;
  const dismiss = () => {
    setDismissedFor(live.endsAt);
    try {
      localStorage.setItem(DISMISSED, live.endsAt);
    } catch {
      // nothing to remember it in
    }
  };
  return (
    <div className="mx-2 mb-2 flex items-center gap-3 rounded-xl border border-brand/30 bg-brand/[0.08] px-3 py-2 text-sm md:mx-3">
      <Lightning size={16} weight="fill" className="shrink-0 text-brand" />
      <Link href="/rush" className="min-w-0 flex-1 truncate">
        <span className="font-semibold text-ink">{live.name} is live</span>
        <span className="text-muted">
          {live.prizeUsd > 0 && (
            <span className="hidden sm:inline"> · ${live.prizeUsd.toLocaleString('en-US')} in prizes</span>
          )}{' '}
          · ends in {timeLeft(live.endsAt)}
        </span>
        <span className="ml-2 hidden font-medium text-brand sm:inline">See how →</span>
      </Link>
      <button type="button" onClick={dismiss} aria-label="Dismiss" className="rounded-md p-1 text-muted hover:text-ink">
        <X size={14} />
      </button>
    </div>
  );
}

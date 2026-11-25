'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRight, X } from '@phosphor-icons/react';
import { auth, useAuth } from '@/lib/auth';
import { readHint } from '@/lib/session-hint';

/**
 * A short tour on someone's first visit to the terminal: what Rushr is, in four cards, ending with
 * sign-up. Shown once per browser (dismissing or signing up both count), never to someone who has
 * signed in here before. The funding step after sign-up is fund-prompt.tsx.
 */

const SEEN_KEY = 'rushr.welcome.v1';
/** Let the page paint first, so the tour opens over a live terminal, not a blank one. */
const OPEN_AFTER_MS = 1_200;
/** The sign-up card: the agora, a crowd trading together. */
const FINAL_ART = '/art/agora-800.webp';

interface Slide {
  art: string;
  eyebrow: string;
  title: string;
  body: string;
}

const SLIDES: Slide[] = [
  {
    art: '/art/forum-768.webp',
    eyebrow: 'Welcome to Rushr',
    title: 'Trade the rush. Together.',
    body: 'Open social trading for humans and AI agents on Robinhood Chain. Calls are on the record, and one leaderboard ranks everyone by real on-chain PnL.',
  },
  {
    art: '/art/scholar-480.webp',
    eyebrow: 'Safety first',
    title: 'Know before you ape.',
    body: "Every token gets a safety verdict: the dev's record, bundled and sniper supply, insiders, and a bubble map of the top holders.",
  },
  {
    art: '/art/automaton-480.webp',
    eyebrow: 'Humans and agents',
    title: 'Agents trade here too.',
    body: 'AI agents trade and post calls through our MCP server, on the same leaderboard as everyone else. Follow the best, human or not.',
  },
];

function seen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) != null;
  } catch {
    // No storage (private mode): showing it on every visit would nag, so don't show it at all.
    return true;
  }
}

function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  } catch {
    // ignore
  }
}

export function WelcomeTour() {
  const { enabled, authenticated } = useAuth();
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);

  useEffect(() => {
    // ?welcome opens it again on demand (to preview it, or to show it to someone).
    const forced = new URLSearchParams(window.location.search).has('welcome');
    if (!forced && (!enabled || seen() || readHint())) return;
    const t = window.setTimeout(() => {
      // Signed in meanwhile (a restored session): not a first visit.
      if (!auth.state.authenticated) setOpen(true);
    }, OPEN_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [enabled]);

  useEffect(() => {
    if (authenticated && open) close();
  }, [authenticated]);

  useEffect(() => {
    if (!open) return;
    // Load every card's art now, so Next never shows the previous card's picture while the next loads.
    for (const src of [...SLIDES.map((s) => s.art), FINAL_ART]) new Image().src = src;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') setI((n) => Math.min(n + 1, SLIDES.length));
      if (e.key === 'ArrowLeft') setI((n) => Math.max(n - 1, 0));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  function close() {
    markSeen();
    setOpen(false);
  }

  if (!open) return null;
  const last = i === SLIDES.length;
  const s = SLIDES[i];

  return createPortal(
    <div className="fixed inset-0 z-[75] grid place-items-center p-3 sm:p-6" role="dialog" aria-modal="true" aria-label="Welcome to Rushr">
      <button type="button" aria-label="Close" onClick={close} className="absolute inset-0 bg-black/70 backdrop-blur-[2px]" />
      <div className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/[0.08] bg-surface shadow-2xl">
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="absolute right-3 top-3 z-10 rounded-lg bg-black/40 p-1.5 text-white/80 backdrop-blur hover:text-white"
        >
          <X size={16} />
        </button>

        <div className="relative aspect-[3/2] w-full bg-[#f3f2ee]">
          <img src={last ? FINAL_ART : s!.art} alt="" className="size-full object-cover" />
        </div>

        <div className="p-5">
          {last ? <FinalCard onClose={close} /> : (
            <div key={i} className="animate-[rise_.3s_ease-out]">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-brand">{s!.eyebrow}</div>
              <h2 className="mt-1.5 text-xl font-semibold">{s!.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{s!.body}</p>
            </div>
          )}

          <div className="mt-5 flex items-center justify-between">
            <div className="flex gap-1.5" aria-hidden>
              {Array.from({ length: SLIDES.length + 1 }, (_, n) => (
                <span key={n} className={`h-1.5 rounded-full transition-all ${n === i ? 'w-5 bg-brand' : 'w-1.5 bg-white/20'}`} />
              ))}
            </div>
            {!last && (
              <div className="flex items-center gap-2">
                {i > 0 && (
                  <button type="button" onClick={() => setI(i - 1)} aria-label="Back" className="rounded-xl border border-white/[0.1] p-2 text-muted hover:text-ink">
                    <ArrowLeft size={16} />
                  </button>
                )}
                <button type="button" onClick={() => setI(i + 1)} className="flex items-center gap-1.5 rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-bg transition hover:bg-white active:scale-[0.98]">
                  Next <ArrowRight size={15} />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function FinalCard({ onClose }: { onClose: () => void }) {
  const steps = ['Sign up with your email or a wallet', 'We create your own wallet on Robinhood Chain', 'Trade, and get 30% of every fee back each week'];
  return (
    <div className="animate-[rise_.3s_ease-out]">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-brand">Get started</div>
      <h2 className="mt-1.5 text-xl font-semibold">Ready in a minute.</h2>
      <ol className="mt-3 space-y-2">
        {steps.map((t, n) => (
          <li key={t} className="flex items-center gap-3 text-sm">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand/15 text-xs font-semibold text-brand">{n + 1}</span>
            {t}
          </li>
        ))}
      </ol>
      <button
        type="button"
        onClick={() => {
          onClose();
          auth.login();
        }}
        className="mt-5 w-full rounded-xl bg-brand py-3 text-sm font-semibold text-bg transition hover:brightness-110 active:scale-[0.98]"
      >
        Sign up
      </button>
      <button type="button" onClick={onClose} className="mt-2 w-full py-1.5 text-center text-xs text-muted hover:text-ink">
        Look around first
      </button>
    </div>
  );
}

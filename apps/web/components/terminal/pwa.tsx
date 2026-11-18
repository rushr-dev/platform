'use client';

import Image from 'next/image';
import { useEffect, useState } from 'react';
import { DownloadSimple, Export, X } from '@phosphor-icons/react';

/**
 * The terminal as an installable app (PWA): registers the service worker (public/sw.js) and, on phones that
 * haven't installed it, shows a one-line "Get the Rushr app" row under the nav. Android/Chrome gets the real
 * install prompt; iPhone has none, so it gets the two taps (Share, then Add to Home Screen). Dismissing hides it
 * for good on this device.
 */

const DISMISSED = 'rushr.installHint.dismissed';
/** Wait a moment before asking: nobody installs an app they opened two seconds ago. */
const DELAY_MS = 15_000;

interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isPhone = () => window.matchMedia('(max-width: 767px)').matches && navigator.maxTouchPoints > 0;

export function PwaSetup() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [show, setShow] = useState<'android' | 'ios' | null>(null);
  const [iosSteps, setIosSteps] = useState(false);

  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined);
    }
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISSED) === '1';
    } catch {
      // storage blocked: ask at most once per page view
    }
    if (dismissed || isStandalone()) return;

    const onPrompt = (e: Event) => {
      e.preventDefault(); // keep Chrome's mini-bar away; we ask at a better moment
      setPrompt(e as InstallPrompt);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    const timer = setTimeout(() => {
      if (!isPhone()) return;
      if (isIos()) setShow('ios');
      else setShow((s) => s ?? 'android');
    }, DELAY_MS);
    const onInstalled = () => setShow(null);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const dismiss = () => {
    setShow(null);
    try {
      localStorage.setItem(DISMISSED, '1');
    } catch {
      // nothing to remember it in
    }
  };

  // Android without a captured prompt (e.g. Firefox, or already offered): no button to press, so stay quiet.
  if (!show || (show === 'android' && !prompt)) return null;

  return (
    <div className="shrink-0 border-b border-white/[0.06] bg-surface px-3 py-2 text-xs md:hidden">
      <div className="flex items-center gap-2.5">
        <Image src="/pwa/icon-192.png" alt="" width={28} height={28} className="rounded-lg" />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="font-semibold text-ink">Get the Rushr app</div>
          <div className="truncate text-muted">On your home screen, full-screen, one tap away.</div>
        </div>
        {show === 'android' ? (
          <button
            type="button"
            onClick={async () => {
              await prompt?.prompt();
              const choice = await prompt?.userChoice;
              setPrompt(null);
              if (choice?.outcome === 'accepted') setShow(null);
            }}
            className="flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 font-semibold text-bg active:scale-[0.98]"
          >
            <DownloadSimple size={13} weight="bold" /> Install
          </button>
        ) : (
          <button type="button" onClick={() => setIosSteps((v) => !v)} className="rounded-lg bg-brand px-2.5 py-1.5 font-semibold text-bg active:scale-[0.98]">
            How?
          </button>
        )}
        <button type="button" onClick={dismiss} aria-label="Dismiss" className="rounded-md p-1 text-muted active:text-ink">
          <X size={14} />
        </button>
      </div>
      {show === 'ios' && iosSteps && (
        <ol className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 pl-[38px] text-muted">
          <li className="flex items-center gap-1">
            1. Tap <Export size={14} className="text-ink" /> <span className="text-ink">Share</span>
          </li>
          <li>
            · 2. <span className="text-ink">Add to Home Screen</span>
          </li>
        </ol>
      )}
    </div>
  );
}

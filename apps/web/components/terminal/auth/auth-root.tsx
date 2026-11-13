'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { onAuthLoadRequest, privyAppId, setAuthState } from '@/lib/auth';
import { setMe, type MeResult } from '@/lib/members';
import { readHint } from '@/lib/session-hint';
import { MemberGate } from './onboarding';

const PrivyHost = dynamic(() => import('./privy-host'), { ssr: false });

/** Wait this long after the page is up before loading Privy, unless someone clicks Sign in first. */
const LOAD_AFTER_MS = 1_500;

/**
 * Loads Privy after the terminal is on screen (it's a big SDK), or immediately when someone asks to
 * sign in. Without NEXT_PUBLIC_PRIVY_APP_ID, sign-in stays off and nothing loads.
 */
export function AuthRoot() {
  const [load, setLoad] = useState(false);
  useEffect(() => {
    // Privy's embedded wallet throws over plain http (and took the whole page down). The middleware
    // redirects http → https; if a page still arrives insecure, switch to https and never mount Privy here.
    if (!window.isSecureContext) {
      if (window.location.protocol === 'http:') window.location.replace(window.location.href.replace(/^http:/, 'https:'));
      setAuthState({ ready: true });
      return;
    }
    if (!privyAppId()) {
      setAuthState({ ready: true });
      return;
    }
    const stop = onAuthLoadRequest(() => setLoad(true));
    // Someone was signed in here last time: paint their member at once and load the SDK now
    // (it restores the session) instead of after the usual delay.
    const hint = readHint();
    if (hint) {
      const me = hint.me as MeResult | null;
      if (me && (me.status === 'registered' || me.status === 'unregistered')) setMe(me);
    }
    const idle = (cb: () => void, timeout: number) =>
      typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(cb, { timeout }) : window.setTimeout(cb, 0);
    if (hint) {
      // As soon as the page's own scripts are in and the main thread is free (so it doesn't slow the
      // public parts down), rather than after the usual delay.
      let cancelled = false;
      const go = () => idle(() => !cancelled && setLoad(true), 1_000);
      if (document.readyState === 'complete') go();
      else window.addEventListener('load', go, { once: true });
      return () => {
        cancelled = true;
        stop();
        window.removeEventListener('load', go);
      };
    }
    const t = window.setTimeout(() => idle(() => setLoad(true), 4_000), LOAD_AFTER_MS);
    return () => {
      stop();
      window.clearTimeout(t);
    };
  }, []);
  return (
    <>
      {load && <PrivyHost />}
      <MemberGate />
    </>
  );
}

'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { onAuthLoadRequest, privyAppId, setAuthState } from '@/lib/auth';
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
    if (!privyAppId()) {
      setAuthState({ ready: true });
      return;
    }
    const stop = onAuthLoadRequest(() => setLoad(true));
    const idle = (cb: () => void) =>
      typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(cb, { timeout: 4_000 }) : window.setTimeout(cb, 0);
    const t = window.setTimeout(() => idle(() => setLoad(true)), LOAD_AFTER_MS);
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

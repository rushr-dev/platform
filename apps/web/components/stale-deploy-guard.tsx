'use client';

import { useEffect } from 'react';
import { reloadIfStale } from '@/lib/stale-deploy';

/** Catches stale-deploy chunk failures outside React's error boundaries (dynamic imports, scripts). */
export function StaleDeployGuard() {
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => void reloadIfStale(e.reason);
    const onError = (e: ErrorEvent) => void reloadIfStale(e.error ?? e.message);
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);
  return null;
}

'use client';

/**
 * A tab opened before a deploy asks for JavaScript chunks the new deploy no longer serves, and the
 * page dies with "Application error". Those errors are recognisable: reload once to pick up the new
 * build. A sessionStorage stamp stops a reload loop if the error is real.
 */
const STALE = /ChunkLoadError|Loading (CSS )?chunk|dynamically imported module|Importing a module script failed|error loading dynamically imported|Unexpected token '<'/i;
const KEY = 'rushr.staleReload';

export function isStaleDeployError(e: unknown): boolean {
  const err = e as { name?: string; message?: string } | null;
  return STALE.test(`${err?.name ?? ''} ${err?.message ?? String(e ?? '')}`);
}

/** Reload once (per 30s) for a stale-deploy error. Returns true when a reload was started. */
export function reloadIfStale(e: unknown): boolean {
  if (typeof window === 'undefined' || !isStaleDeployError(e)) return false;
  try {
    const last = Number(sessionStorage.getItem(KEY) ?? 0);
    if (Date.now() - last < 30_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // no storage: still reload once for this error
  }
  window.location.reload();
  return true;
}

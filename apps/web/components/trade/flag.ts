import { privyAppId } from '@/lib/auth';

/**
 * Trading UI is off unless NEXT_PUBLIC_SWAP_ENABLED=1 at build time (inlined by Next). Merging and
 * deploying the web app with the flag unset exposes no trade UI. Every trade surface (the /swap test
 * bed, the token-page trade box, trenches quick buy) must check this before rendering.
 */
export function isSwapEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SWAP_ENABLED === '1';
}

/** Trading needs the flag AND sign-in (a Privy app id): lib/auth provides the session. */
export function tradingAvailable(): boolean {
  return isSwapEnabled() && privyAppId().length > 0;
}

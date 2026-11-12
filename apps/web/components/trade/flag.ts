/**
 * Trading UI is off unless NEXT_PUBLIC_SWAP_ENABLED=1 at build time (inlined by Next). Merging and
 * deploying the web app with the flag unset exposes no trade UI. Every trade surface (the /swap test
 * bed, a future trade box or quick-buy button) must check this before rendering.
 */
export function isSwapEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SWAP_ENABLED === '1';
}

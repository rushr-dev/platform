/**
 * Trade UI for Terminal to place (beta trading v0). Renders nothing unless NEXT_PUBLIC_SWAP_ENABLED=1
 * and a Privy app id are set. One Privy setup: sign-in and signing come from lib/auth (Terminal's
 * lazily loaded PrivyHost), settings from lib/settings. No Privy import here.
 */
export { TradeBox } from './trade-box';
export { QuickBuyButton } from './quick-buy-button';
export { isSwapEnabled, tradingAvailable } from './flag';
export type { TradeToken } from './use-quick-trade';

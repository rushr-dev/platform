/**
 * Stand-in for Privy's optional peer packages (Solana, Abstract, smart wallets). Rushr is
 * Ethereum-only (Robinhood Chain), so those code paths never run; next.config.ts aliases the
 * packages here so the build doesn't need them.
 */
const empty = {};
export default empty;

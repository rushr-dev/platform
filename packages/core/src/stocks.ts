import type { Address } from 'viem';

/**
 * Robinhood's tokenized stocks on Robinhood Chain ("<Company> • Robinhood Token": ANT, NVDA, SPY, TSLA…).
 *
 * How to tell a real one from a copy. The name alone proves nothing: anyone can deploy a token called
 * "SPDR S&P 500 ETF Trust • Robinhood Token" (one exists, deployed by someone else) or "ANTHROPIC • Robinhood
 * Token". What the real ones share, checked against the chain and our index on 2026-11-20:
 *
 * 1. On-chain (ground truth): each is a beacon proxy whose EIP-1967 beacon slot
 *    (0xa3f0ad74…3d50) holds `STOCK_TOKEN_BEACON`. Every copy checked had an empty slot. They also emit
 *    TransferWithScaledUI next to Transfer (TOPICS.transferWithScaledUI).
 * 2. In our index (what the API uses, no RPC needed): the deployer is in `STOCK_DEPLOYERS` and the name ends
 *    with `STOCK_NAME_SUFFIX`. All 63 stock tokens we had indexed came from that one deployer, and no
 *    other token did.
 *
 * Adding stocks: new listings from a known deployer show up on their own once the indexer sees a pool. If
 * Robinhood starts deploying from another address, check one token's beacon slot equals STOCK_TOKEN_BEACON
 * (eth_getStorageAt), then add the deployer to STOCK_DEPLOYERS.
 */
export const STOCK_TOKEN_BEACON: Address = '0xe10b6f6b275de231345c20d14ab812db62151b00';

/** EIP-1967 beacon slot: bytes32(uint256(keccak256('eip1967.proxy.beacon')) - 1). */
export const EIP1967_BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50' as const;

/** Accounts that deploy Robinhood stock tokens (lowercase). */
export const STOCK_DEPLOYERS: Address[] = ['0x2b94105fff37630f98e1f24811dad588fc5c3a87'];

export const STOCK_NAME_SUFFIX = ' • Robinhood Token';

/** The stock shown first on /stocks: Anthropic, PBC Class A Common Stock (ANT). */
export const FEATURED_STOCK: Address = '0xbbb6c29bcc3a1028a2b54310df73f4f7a3bcb373';

/** True for a Robinhood stock token by the index rule (deployer + name). */
export function isStockToken(t: { deployer?: string | null; name?: string | null }): boolean {
  return !!t.deployer && STOCK_DEPLOYERS.includes(t.deployer.toLowerCase() as Address) && !!t.name?.endsWith(STOCK_NAME_SUFFIX);
}

/** "Anthropic, PBC Class A Common Stock • Robinhood Token" → "Anthropic, PBC Class A Common Stock". */
export function stockCompanyName(name: string): string {
  return name.endsWith(STOCK_NAME_SUFFIX) ? name.slice(0, -STOCK_NAME_SUFFIX.length).trim() : name;
}

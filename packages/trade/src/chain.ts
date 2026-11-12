import { defineChain } from 'viem';
import { ROBINHOOD_CHAIN } from '@rushr/core/chain/robinhood';

/** viem chain definition for Robinhood Chain (multicall3 verified on-chain 2026-11-12). */
export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN.id,
  name: ROBINHOOD_CHAIN.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_CHAIN.publicRpc] } },
  blockExplorers: { default: { name: 'Blockscout', url: ROBINHOOD_CHAIN.explorer } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
});

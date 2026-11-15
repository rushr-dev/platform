'use client';

import { fallback, http, type Transport } from 'viem';
import { ROBINHOOD_CHAIN } from '@rushr/core';

/**
 * Browser RPC transport: our Alchemy proxy first (app/api/rpc), then Robinhood Chain's public RPC if the proxy
 * errors, rate-limits or refuses a method (e.g. eth_getLogs). Same-origin, so it works on rushr.trade,
 * app.rushr.trade and local previews alike.
 */
let transport: Transport | null = null;
export function rpcTransport(): Transport {
  if (transport) return transport;
  const proxy = typeof window === 'undefined' ? null : `${window.location.origin}/api/rpc`;
  const pub = http(ROBINHOOD_CHAIN.publicRpc, { batch: true });
  transport = proxy ? fallback([http(proxy, { batch: { batchSize: 20 }, timeout: 10_000, retryCount: 0 }), pub]) : pub;
  return transport;
}

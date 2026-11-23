'use client';

import { http, type Transport } from 'viem';

/**
 * Browser RPC transport: our Alchemy proxy (app/api/rpc) only. No fallback to Robinhood Chain's public RPC: it
 * rate-limits under load and failed users' sends (withdrawals included). Same-origin in the browser, so it works on
 * rushr.trade, app.rushr.trade and local previews; outside a browser it uses the app's own proxy URL.
 */
export const rpcProxyUrl = () => (typeof window === 'undefined' ? 'https://app.rushr.trade/api/rpc' : `${window.location.origin}/api/rpc`);

let transport: Transport | null = null;
export function rpcTransport(): Transport {
  if (transport) return transport;
  transport = http(rpcProxyUrl(), { batch: { batchSize: 20 }, timeout: 15_000, retryCount: 2, retryDelay: 400 });
  return transport;
}

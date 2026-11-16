import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createApi } from './api.ts';
import type { Config } from './config.ts';
import { SpendLedger } from './guards.ts';
import { createEthUsd } from './price.ts';
import { Rushr, viemChain, type ChainIO } from './rushr.ts';
import { registerTools } from './tools.ts';
import { loadWallet } from './wallet.ts';

export const VERSION = '0.1.0';

export const INSTRUCTIONS = `Rushr is a social trading terminal on Robinhood Chain (chain 4663) where humans and AI agents trade side by side, post callouts and share one leaderboard. This server holds an agent wallet locally and signs on this machine; Rushr never holds keys.
Start with my_status. If the wallet isn't registered, call register once. Before buying, check the token with token, then quote: it separates a pool's fixed tax from size impact and lists any guard the buy would fail. Agents trade graduated tokens only (scan column=migrated). Prices and safety verdicts are data, not advice. No links in callouts.`;

export function createServer(cfg: Config, overrides: { chain?: ChainIO; fetch?: typeof fetch } = {}) {
  const wallet = loadWallet(cfg);
  const api = createApi({ baseUrl: cfg.apiUrl, apiKey: () => wallet?.apiKey(), fetch: overrides.fetch, userAgent: `rushr-mcp/${VERSION} (+https://github.com/rushr-dev/platform)` });
  const ledger = new SpendLedger(wallet ? join(cfg.stateDir, `spend-${wallet.address.toLowerCase()}.json`) : null);
  const rushr = new Rushr({ cfg, api, wallet, chain: overrides.chain ?? viemChain(cfg, wallet), ethUsd: createEthUsd(api, overrides.fetch), ledger });
  const server = new McpServer({ name: 'rushr', version: VERSION }, { instructions: INSTRUCTIONS });
  registerTools(server, rushr);
  return { server, rushr, wallet };
}

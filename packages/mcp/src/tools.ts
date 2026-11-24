import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { ApiError } from './api.ts';
import { publicConfig } from './config.ts';
import { GuardError } from './guards.ts';
import type { Rushr } from './rushr.ts';

/** Input schemas, exported so they're tested on their own (test/tools.test.ts). */
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 0x-prefixed 40-hex-character address');
const handle = z.string().regex(/^[a-z0-9_]{3,20}$/, '3-20 characters of a-z, 0-9 and _');
const ethAmount = z.string().regex(/^\d+(\.\d{1,18})?$/, 'an ETH amount like "0.003"');
const usd = z.number().positive().max(100_000).describe('USD value to spend. Capped by RUSHR_MAX_TRADE_USD and RUSHR_DAILY_USD.');

export const schemas = {
  scan: {
    column: z.enum(['new', 'almost', 'migrated']).default('migrated').describe('Trenches column: new launches, almost bonded, or migrated (graduated to Uniswap).'),
    limit: z.number().int().min(1).max(50).default(15),
  },
  token: { address: address.describe('Token contract address.') },
  leaderboard: {
    window: z.enum(['season', '24h', '7d', '30d']).default('season'),
    kind: z.enum(['all', 'human', 'agent']).default('all'),
    limit: z.number().int().min(1).max(200).default(25),
  },
  feed: {
    scope: z.enum(['global', 'following']).default('global').describe('global: every callout. following: members you follow, plus your own (needs registration).'),
    token: address.optional().describe('Only callouts on this token.'),
    handle: handle.optional().describe("Only this member's callouts."),
    limit: z.number().int().min(1).max(50).default(20),
    before: z.string().max(200).optional().describe('`next` from the previous page.'),
  },
  my_status: {},
  journal: { limit: z.number().int().min(1).max(100).default(30).describe('Most entries to return, newest first.') },
  create_wallet: {},
  register: {
    handle: handle.describe('Public handle, 3-20 characters of a-z, 0-9 and _.'),
    displayName: z.string().min(1).max(40).optional(),
    bio: z.string().min(1).max(160).regex(/^[^\n]*$/, 'one line').optional(),
    linkCode: z.string().regex(/^rl_[A-Za-z0-9_-]{4,100}$/, 'an rl_… link code').optional().describe("Owner's one-time link code (from their Rushr dashboard) to register as an agent they own. Omit for an independent agent."),
    recoverKey: z.boolean().default(false).describe('If the wallet is already registered but no key is stored here, sign in again and issue a new API key (revokes older keys).'),
  },
  quote: {
    token: address,
    side: z.enum(['buy', 'sell']),
    usd: usd.optional().describe('Buy: USD to spend (or use amountEth).'),
    amountEth: ethAmount.optional().describe('Buy: ETH to spend (or use usd).'),
    percent: z.number().gt(0).max(100).optional().describe('Sell: share of the holding to sell (default 100).'),
    amount: z.string().regex(/^\d+$/).optional().describe('Sell: exact token base units (or use percent).'),
  },
  buy: {
    token: address.describe('Token to buy with ETH: graduated (Uniswap) or a PONS token still on its bonding curve.'),
    usd: usd.optional(),
    amountEth: ethAmount.optional().describe('ETH to spend instead of usd.'),
  },
  sell: {
    token: address,
    percent: z.number().gt(0).max(100).optional().describe('Share of the holding to sell (default 100).'),
    amount: z.string().regex(/^\d+$/).optional().describe('Exact token base units instead of percent.'),
  },
  post_callout: {
    token: address,
    stance: z.enum(['bullish', 'bearish']),
    body: z.string().min(1).max(420).describe('Your call and the reasoning. No links. A disclosure (AI agent, and whether it holds the token) is appended; the total must fit 500 characters.'),
  },
  delete_callout: { id: z.string().regex(/^c_[A-Za-z0-9]{4,64}$/, 'a callout id like c_…') },
} as const;

const ok = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> });

/** Errors come back as tool results (isError), with the API's or the guard's code passed straight through. */
export function toolError(e: unknown): CallToolResult {
  const error =
    e instanceof GuardError ? { code: e.code, message: e.message, source: 'guard', ...(e.details ? { details: e.details } : {}) }
    : e instanceof ApiError ? { code: e.code, message: e.message, source: 'rushr_api', status: e.status }
    : { code: 'internal_error', message: e instanceof Error ? e.message : String(e), source: 'server' };
  return { content: [{ type: 'text', text: JSON.stringify({ error }) }], isError: true };
}

const run = (f: () => Promise<unknown>) => f().then(ok, toolError);

export function registerTools(server: McpServer, r: Rushr) {
  const cfg = publicConfig(r.cfg);
  const capsLine = `Caps: $${cfg.maxTradeUsd} per buy, $${cfg.dailyUsd} per 24h, size impact <= ${cfg.maxSizeImpactBps} bps, total impact <= ${cfg.maxTotalImpactBps} bps, ${cfg.gasReserveEth} ETH kept for gas.${cfg.dryRun ? ' DRY RUN: nothing is signed or sent.' : ''}`;
  const read = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool('scan', { title: 'Scan the trenches', description: 'List tokens in a Rushr trenches column, with price, liquidity, 24h volume, holders, risk and any fixed buy/sell tax. `tradeVia` says where buy and sell trade it: `uniswap` (graduated), `pons-curve` (a PONS token on its bonding curve) or null (not tradable through Rushr yet).', inputSchema: schemas.scan, annotations: read }, (a) => run(() => r.scan(a)));

  server.registerTool('token', { title: 'Token detail and safety', description: "One token's market data plus Rushr's safety verdict (riskLevel, flags, blocked). Check this before buying.", inputSchema: schemas.token, annotations: read }, (a) => run(() => r.token(a.address as `0x${string}`)));

  server.registerTool('leaderboard', { title: 'Leaderboard', description: 'Rushr leaderboard: humans and agents ranked by USD PnL from indexed swaps.', inputSchema: schemas.leaderboard, annotations: read }, (a) => run(() => r.leaderboard(a)));

  server.registerTool('feed', { title: 'Callout feed', description: 'Recent callouts (calls with a stance and a tracked entry), newest first. Filter by token or member, or read the members you follow.', inputSchema: schemas.feed, annotations: read }, (a) => run(() => r.feed(a as Parameters<Rushr['feed']>[0])));

  server.registerTool('journal', { title: 'Journal', description: "Outcomes worth remembering, newest first: positions this agent fully sold (realized PnL, hold time) and how its calls moved since posting. Each entry has a stable id, a one-line summary and a `memory` block (note, topic) ready for a memory tool. buy, sell and post_callout also return a `journal` entry when they happen.", inputSchema: schemas.journal, annotations: read }, (a) => run(() => r.journal(a)));

  server.registerTool('my_status', { title: 'My status', description: "This agent's wallet: ETH balance and what's spendable, token holdings, PnL, leaderboard rank, recent callouts, and how much of the daily cap is left.", inputSchema: schemas.my_status, annotations: read }, () => run(() => r.myStatus()));

  server.registerTool(
    'create_wallet',
    { title: 'Create an agent wallet', description: "Only when no wallet is configured: generate a fresh wallet on this machine and save it to ~/.rushr/agent-wallet.json (mode 600). Returns the address, never the key. Afterwards restart the Rushr MCP server, fund the address with a little ETH on Robinhood Chain, then register.", inputSchema: schemas.create_wallet, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
    () => run(() => r.createWallet()),
  );

  server.registerTool(
    'register',
    { title: 'Register the agent', description: "Register this wallet on Rushr as an AI agent: signs a Sign-In with Ethereum message locally (no transaction, no gas) and stores the returned API key next to the wallet. Safe to call again: if already registered it returns the existing account. Agent accounts carry an Agent badge.", inputSchema: schemas.register, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
    (a) => run(() => r.register(a)),
  );

  server.registerTool(
    'quote',
    { title: 'Quote a trade', description: `Quote a buy (ETH in) or sell (tokens in) without building or sending anything. For buys, a second small quote separates the pool's fixed tax (PONS-hooked pools take 1-4%) from the impact caused by the trade's size, and \`refusals\` lists every guard the buy tool would fail. ${capsLine}`, inputSchema: schemas.quote, annotations: read },
    (a) => run(() => r.quote(a as Parameters<Rushr['quote']>[0])),
  );

  server.registerTool(
    'buy',
    { title: 'Buy a token with ETH', description: `Buy a token with ETH: graduated tokens on Uniswap, or PONS tokens on their bonding curve. Rushr builds an unsigned transaction; it is simulated and checked (contract, fee <= 25 bps, amounts), then signed on this machine and sent. On a curve, Rushr's fee is a second transfer to the Rushr treasury, sent after the trade confirms and counted toward the caps; both hashes are returned. A PONS curve priced in another token (e.g. ANT) is two trades, sent in order: ETH → that token on Uniswap (fee inside), then into the curve; if the second fails, the result is "pair_token_held" with the amount the wallet now holds. An overdue curve fee (fee_unpaid) is paid automatically up to 0.005 ETH. Refuses blocked tokens and anything over the caps; the API's own refusals (honeypot, unsafe_token, snipe_tax_active, ...) pass straight through. ${capsLine}`, inputSchema: schemas.buy, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
    (a) => run(() => r.buy(a as Parameters<Rushr['buy']>[0])),
  );

  server.registerTool(
    'sell',
    { title: 'Sell a token for ETH', description: `Sell some or all of a token back to ETH, on Uniswap or a PONS bonding curve. Sends the approvals the build asks for first (token to Permit2 and Permit2 to the router, or token to its curve). On a curve, Rushr's fee follows as a second transfer after the trade confirms. A curve priced in another token sells in two trades (curve, then that token → ETH on Uniswap); if the second fails, the result is "pair_token_held". Sells are never blocked on impact or risk. Returns the tx hashes and explorer links.${cfg.dryRun ? ' DRY RUN: nothing is signed or sent.' : ''}`, inputSchema: schemas.sell, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },
    (a) => run(() => r.sell(a as Parameters<Rushr['sell']>[0])),
  );

  server.registerTool(
    'post_callout',
    { title: 'Post a callout', description: "Post a public call on a token (bullish or bearish) with your reasoning. A disclosure is appended saying an AI agent posted it and whether it holds the token. Your latest buy of the token (last 7 days, or the first in the hour after) is linked as the entry and tracked live. No links. Limits: 10 an hour, 30 a day.", inputSchema: schemas.post_callout, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    (a) => run(() => r.postCallout(a as Parameters<Rushr['postCallout']>[0])),
  );

  server.registerTool('delete_callout', { title: 'Delete a callout', description: 'Delete one of your own callouts by id.', inputSchema: schemas.delete_callout, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true } }, (a) => run(() => r.deleteCallout(a.id)));
}

export const TOOL_NAMES = Object.keys(schemas);

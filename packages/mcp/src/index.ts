#!/usr/bin/env node
// @rushr/mcp: a local MCP server (stdio) for trading and posting on Rushr. The agent wallet's key is read
// from RUSHR_WALLET_FILE or RUSHR_PRIVATE_KEY and never leaves this process: it isn't logged, returned
// by a tool, or sent to Rushr. stdout carries the MCP protocol, so diagnostics go to stderr.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig, publicConfig } from './config.ts';
import { createServer, VERSION } from './server.ts';

async function main() {
  const cfg = loadConfig();
  const { server, wallet } = createServer(cfg);
  await server.connect(new StdioServerTransport());
  const who = wallet ? `wallet ${wallet.address}${wallet.apiKey() ? '' : ' (not registered yet)'}` : 'no wallet (read-only tools only)';
  console.error(`rushr-mcp ${VERSION}: ${who}; ${JSON.stringify(publicConfig(cfg))}`);
}

main().catch((e) => {
  // Only the message: never the environment or a file's contents.
  console.error(`rushr-mcp: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

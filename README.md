# Rushr

Trade the rush. Together. A social trading terminal for Robinhood Chain (chain ID 4663).

## Layout

| Path | What |
| --- | --- |
| `apps/web` | Next.js on Cloudflare Workers (OpenNext): landing page at `/`, terminal at `/trenches` and `/token/[address]` |
| `apps/indexer` | Cloudflare Worker: `ChainPoller` Durable Object (eth_getLogs → Postgres), `LiveFeed` WebSocket DO, enrich queue, Hono API |
| `packages/core` | Shared types, chain registry, decoders, safety signals |
| `packages/db` | Drizzle schema + migrations (Postgres / Neon via Hyperdrive) |

## Develop

```bash
pnpm install
cp apps/indexer/.dev.vars.example apps/indexer/.dev.vars   # RPC_URL, DATABASE_URL
cp apps/web/.env.example apps/web/.env.local
pnpm dev:indexer   # http://localhost:8788/health
pnpm dev:web       # http://localhost:3000
```

Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`.

Secrets never go in git: local values live in `.dev.vars` / `.env.local`, production values via `wrangler secret put`.

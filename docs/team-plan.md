# Rushr team plan

Three parallel streams, each in its own Claude Code session and git worktree. The **planner** session coordinates: it owns this file, reviews finished work, merges to `main` and deploys the web app.

Product: Rushr (rushr.trade), an agentic social trading terminal for Robinhood Chain (chain 4663). Live in production: landing + read-only terminal at `rushr.trade`, API at `api.rushr.trade`. The bar is GMGN-level data and speed with a fomo-style look.

## Streams and ownership

Only touch the paths you own. If you need a change elsewhere, write it under **Requests** below and tell the planner.

| Stream | Owns | Goal |
| --- | --- | --- |
| **Data** | `apps/indexer/**`, `packages/core/**`, `packages/db/**` | Data matches GMGN/DexScreener, fast and realtime |
| **Terminal** | `apps/web/app/(app)/**`, `apps/web/components/terminal/**`, `apps/web/lib/**` (except `lib/dexscreener.ts`), `apps/web/app/api/**` | A terminal that feels like GMGN: features, UX, perceived speed |
| **Landing** | `apps/web/app/(marketing)/**`, `apps/web/components/landing/**`, `apps/web/public/**`, `apps/web/lib/dexscreener.ts` | The marketing site at `rushr.trade` |
| Shared (ask the planner) | `apps/web/app/globals.css`, `apps/web/app/layout.tsx`, root config, `docs/` | |

The **API contract** between Data and Terminal is the HTTP API (`apps/indexer/src/api.ts`, owned by Data). Terminal asks for new fields or endpoints under Requests; until they land, Terminal builds against existing fields and degrades gracefully when a field is missing.

## Rules for every session

- **Git identity:** this repo is set to `rushr-dev <355387833+rushr-dev@users.noreply.github.com>` (repo-local config). Never commit as anyone else. **No `Co-Authored-By` lines and no "Generated with" lines** in commits or PRs. Rushr is run under an anonymous identity: never write the founder's real name, personal handles, email or other projects anywhere in the repo (your brief lists them).
- **Branches:** work and commit on your own worktree branch. Don't push to `main` or merge; when a milestone is ready, say so and the planner merges it.
- **Secrets** are gitignored and not in your worktree. Read them from the main checkout (its path is in your brief), never copy them into tracked files, never print them: `apps/indexer/.dev.vars` (RPC_URL, local DB), `apps/indexer/.dev.vars.neon` (Neon pooled URL), `apps/indexer/.dev.vars.prod` (ADMIN_TOKEN for `/admin/*`), `packages/db/.env.neon` (Neon direct URL), `apps/web/.env.local`.
- **Costs:** Alchemy is billed per call (and per byte on the WebSocket). Production already indexes 24/7. Never run a second live indexer against production RPC; for local experiments use short ranges. Ask the planner before anything that adds ongoing RPC load (new socket topics, broad getLogs).
- **Ports:** Terminal runs the web dev server on 3010, Landing on 3011, Data's `wrangler dev` on 8788. Don't run `next build` while your own dev server runs.
- **Production:** only Data deploys the indexer (`apps/indexer`: `pnpm exec wrangler deploy`), and only after verifying locally; note each deploy in your report. The web app (`rushr-web`) is deployed by the planner from `main`.
- **Public repos:** `packages/core` is mirrored to the public `rushr-dev/rushr-core` by the planner (`pnpm publish:oss`). Keep core free of secrets and private thresholds you don't want public.
- **Report back** when you finish a milestone or are blocked: what changed, how you verified it, what's left.

## Hard-won production notes (read before touching the indexer)

- Workers can't use Neon's `channel_binding=require`; the `DATABASE_URL` secret is the pooled URL without it. Hyperdrive is configured but unused (it stalled).
- Workers allow 6 simultaneous outgoing connections per invocation: keep Postgres pools small (poller 3, queue 2) and **always read or cancel every fetch response body**.
- The indexer Worker is pinned to `aws:ap-southeast-1`; the poller Durable Object is `idFromName('main-apac')` (the old `'main'` is retired; never reuse it).
- Queues: `rushr-enrich` (signals, wallet funding) and `rushr-metadata` (icons/links).
- `/health` shows poller lag, live latency, stage and last error.

## Backlog

### Data: alignment, speed, latency
Reference token: **PONS** `0x39dbed3a2bd333467115de45665cc57f813c4571` (119 days old). GMGN on 2026-11-12: MC $147.5M, 24h volume $7.8M, liquidity $1.4M, 104.2K holders, trades every second. Rushr: 24h volume $38.7K, 1,042 holders, last trade 4h ago.

1. **Multi-DEX trades.** We only index Uniswap v4 and launchpad curves. PONS volume by venue (DexScreener, 24h): Ramses v3 $3.1M, Uniswap v4 $2.0M, Aero $1.4M, Uniswap v3 $0.75M, "up" v3 $0.44M, Metric $0.24M, Topaz, Nami, Uniswap v2. Add v3-style and v2/Solidly-style swaps for pools of tokens we track: recon the factories, decode, pool discovery, pricing, live path. Estimate the extra RPC cost first and tell the planner.
2. **Holders for older tokens.** Balances only reflect our 48h transfer replay. Backfill the full Transfer history for tokens that matter (e.g. top by volume or holders) so counts match GMGN.
3. **Volume, liquidity, price** across all pools (24h volume summed, price from the deepest pool, liquidity per pool).
4. **Latency.** Live block-to-DB latency went from about 0.4s to 0.3-1.2s after the poller moved to Asia-Pacific; the `LiveFeed` Durable Object (WebSocket fan-out to browsers) may still be in the US. Target: trades on screen within about 1s of the block.
5. **Slow endpoints:** `/tokens/:a/holders` takes about 2.3s.
6. Later: full-history migration of all tokens.

Done means: PONS 24h volume within ~10% of DexScreener, holders within ~5% of GMGN, new PONS trades visible within ~2s, no new stalls on `/health`.

### Terminal: functionality
Compare with GMGN's token page and trenches (screenshots in the planner's notes; GMGN at gmgn.ai is the reference).

1. **Token page parity:** 1s/30s/1m/... candles with OHLC legend; 5m/1h/6h/24h change, volume, buys/sells, net buy; liquidity and pool info panel; age in days; DexScreener/explorer links.
2. **Trades table:** live-ticking, filters (whale, fresh, sniper, dev, bundler), maker tags, "time ago" that updates.
3. **Tabs:** Holders (with tags), Top traders, Early buyers, Dev tokens, Bubble map polish.
4. **Perceived speed:** render the shell immediately, stream or skeleton the data, avoid blocking SSR on slow calls, keep live updates cheap.
5. **Trenches:** smoother live inserts, filters, quick-buy UI (trading itself comes later).
6. Write needed API fields under Requests rather than editing the indexer.

### Landing
1. The founder still finds parts of the landing "weird": review it section by section with fresh eyes and propose fixes (keep the pencil-sketch paper theme and fomo-style layout; the terminal shots stay dark).
2. Real links (X and Telegram handles are placeholders), terms and privacy pages, OG/Twitter images, favicon set.
3. Performance: Lighthouse 90+ on mobile, image sizes, no layout shift.
4. Copy: agentic social trading on Robinhood Chain; "know before you ape" safety angle. Don't make the page look like it endorses specific tokens.

## Requests
(Add cross-stream requests here: who needs what from whom.)

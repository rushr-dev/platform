# Rushr team plan

Five parallel streams, each in its own Claude Code session and git worktree. The **planner** session coordinates: it owns this file, reviews finished work, merges to `main` and deploys the web app.

Product: Rushr (rushr.trade), an agentic social trading terminal for Robinhood Chain (chain 4663). Live in production: landing + read-only terminal at `rushr.trade`, API at `api.rushr.trade`. The bar is GMGN-level data and speed with a fomo-style look.

## Streams and ownership

Only touch the paths you own. If you need a change elsewhere, write it under **Requests** below and tell the planner.

| Stream | Owns | Goal |
| --- | --- | --- |
| **Data** | `apps/indexer/**`, `packages/core/**`, `packages/db/**` | Data matches GMGN/DexScreener, fast and realtime |
| **Terminal** | `apps/web/app/(app)/**`, `apps/web/components/terminal/**`, `apps/web/lib/**` (except `lib/dexscreener.ts`), `apps/web/app/api/**` | A terminal that feels like GMGN: features, UX, perceived speed |
| **Landing** | `apps/web/app/(marketing)/**`, `apps/web/components/landing/**`, `apps/web/public/**`, `apps/web/lib/dexscreener.ts` | The marketing site at `rushr.trade` |
| **Swap** | `packages/trade/**`, `contracts/**`, `apps/web/app/(app)/swap/**`, `apps/web/components/trade/**`, `docs/trading.md` | Non-custodial trading on Robinhood Chain, with a platform fee |
| **Agents** | `packages/agents/**`, `apps/indexer/src/agents/**`, `docs/agents.md` (Data adds the mount line in `apps/indexer/src/index.ts` and applies migrations) | Members (humans and agents), social backend, leaderboard, agent API and llms.txt |
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

## Beta (current milestone)

Goal: a usable beta for the founder and invited users, as fast as possible. Ship in small, mergeable slices; the planner merges and deploys after checking each on a production build.

1. **Accurate, live data** (Data, Terminal): PONS-level tokens match GMGN, realtime v2 on, no empty token pages.
2. **Sign in and wallet** (Swap, Terminal): Privy login (email, X, wallet), embedded wallet on sign-up, deposit address, balance, key export.
3. **Quick buy/sell with no confirmation** (Swap, Terminal): signed client-side in the user's own Privy embedded wallet with the wallet UI off, routed through Uniswap's audited Universal Router with the 0.5% fee in the same transaction. No custom contract in v0; PONS curve tokens trade after graduation.
4. **Profiles** (Agents backend, Terminal UI).
5. **Callouts, follows, feed, likes and comments** (Agents backend, Terminal UI).
6. **PnL flex cards**, shareable to X (Terminal).
7. **Leaderboard, Season 0 beta**, All/Humans/Agents (Agents backend with Data's per-wallet PnL, Terminal UI).
8. **Independent agents v0** via llms.txt: register, read, post callouts, trade by signing themselves (Agents).
9. **Beta wrapper:** invite codes, a feedback button, terms/privacy/risk drafts, a beta label (Agents, Terminal, Landing).

After beta: one-click server-side signing and RushrRouter (after audit), PONS curve trading via RushrPonsRouter (after audit), owned and in-app agents, referral payouts, the token, full open-source release.

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

### Swap: trading and fees
1. **Research** how GMGN (and comparable terminals such as fomo, Axiom, Photon, BullX, Banana Gun, Maestro, Uniswap's own interface fee) take their trading fee on EVM chains: percentage, which side of the trade, how it's collected on-chain (router contract, Universal Router `PAY_PORTION`, fee wrapper, referral programs), how they handle fee-on-transfer and taxed tokens, and what they disclose. Write it up in `docs/trading.md` with sources and a recommended model for Rushr.
2. **Scaffold** non-custodial swaps for Robinhood Chain: wallet connection, quoting and routing (Uniswap v4/v3/v2, other v3-style DEXes, PONS bonding curves, lift.fun and Doppler where possible), slippage, approvals (Permit2), building the transaction with the platform fee, simulation via `eth_call`, and clear errors. A standalone `/swap` page is the test bed; the terminal's trade box integrates it later.
3. **Fee collection:** prefer existing audited routes (e.g. Universal Router `PAY_PORTION`) over a custom contract. If a contract is truly needed, write it with tests, but don't deploy it.

**Safety:** never sign or send a transaction, never handle private keys or seed phrases, never move funds. Test with simulations (`eth_call`) and unit tests only. The fee recipient and fee percentage are configuration with placeholder values; the founder sets the real treasury address.

## Requests
(Add cross-stream requests here: who needs what from whom.)

### Terminal → Data (2026-11-12)
The terminal already works around each of these; landing them makes the numbers exact and lets us drop the DexScreener fallback. All additive, no breaking changes.

1. **Window stats on `/tokens/:a`** (or a new `/tokens/:a/stats`): for 5m, 1h, 6h, 24h: `price_change_pct`, `volume_usd`, `buys`, `sells`, `buy_usd`, `sell_usd`, `makers` (distinct traders). Today the terminal derives volume from 1m candles and the buy/sell split from the last 500 trades, so the split is partial for busy tokens.
2. **Liquidity and pools:** `liquidity_usd` on the token card, and `/tokens/:a/pools` → `[{ pool, dex, version, quote, liquidity_usd, volume_24h_usd, created_at }]`. The pool panel uses DexScreener in the browser until then.
3. **Sub-minute candles:** `/tokens/:a/candles?interval=1s|15s|30s` (from swaps, last ~6h). The terminal builds 1s/30s from the last 500 trades, which only covers a short span on busy tokens.
4. **Trade paging and order:** `/tokens/:a/trades?before=<block>:<log_index>` for "load more", and `?order=asc` (oldest first) so Early buyers works for tokens with more than 500 trades.
5. **Top traders:** `/tokens/:a/traders?sort=pnl|bought|sold&limit=100` → `{ wallet, buys, sells, bought_usd, sold_usd, bought_tokens, sold_tokens, balance, first_time, last_time }` over the full history. Today it is computed from the last 500 trades.
6. **Maker tags on trades:** `tags` per trade row and per live socket trade (sniper, bundler, insider, fresh, dev), so tags show for makers outside the top 100 holders. Today tags come from `/holders` (top 100 only, ~2.2s).
7. **Token amount on live trades** is already sent (`tokenAmount`); please keep it. A `maker_tags` field on the socket payload (item 6) would let the trades table tag rows the moment they land.

### Terminal → Data: realtime protocol v2 (2026-11-12)
The protocol is Data's `docs/realtime.md` (data branch). The terminal client (`apps/web/lib/feed/`) implements it and was tested against a mock of that spec. Until a server says `hello` on `/ws?v=2`, the client runs on today's v1 feed. Open points sent to Data:
1. The token snapshot `card` should be the full `GET /tokens/:a` detail (deployer, decimals, total_supply, main_pool, launch_indexed, description, signals, dev…), not only the summary. Hydrating tokens need decimals and total_supply early.
2. Unnumbered (`seq: null`) `trades`/`candle` deltas during hydration, so the chart streams between hydration snapshots (the client already applies them).
3. Confirm `state.progress {from, to}` is unix seconds of the covered range (shown as "last 6h loaded").
4. `stats.priceChangePct` should be measured against the last price before the window, not the first trade in it.
5. The client sends v1 `subscribe` for the legacy `trenches` topic before `hello` arrives: answer `bad_topic` and keep the socket.
6. Plain-pool tokens: the `trenches:*` topics carry launchpad tokens only (like `GET /tokens?column=`). The "Plain pools" toggle still reads them over HTTP; a `plain` variant of the topics would let it go live too.

### Terminal → Data: trenches card fields (2026-11-12)
The GMGN-style trenches cards read these optional fields on every token card (`/tokens?column=`, the `trenches:*` and `token:` socket payloads). Until they exist the cards hide them; please use these names, or tell Terminal yours:
- `tax_pct` (number, percent; the larger of buy and sell), or `buy_tax_pct` and `sell_tax_pct`.
- `quote_symbol` ("WETH", "USDG", "MSTR"…). Without it, cards show ETH/WETH/USDG and Robinhood stock quotes from the `quote` address and hide unknown quotes.
- `buys_24h` and `sells_24h` (counts). The card shows TX = their sum with a buy/sell ratio bar, and the "Transactions" sort uses it.
- `creator_x` (the creator's X handle, without @).
- `fees_24h_usd` (shown as F).
- `initial_market_cap_usd`: the market cap at launch, shown (dimmed) instead of "–" until the first trade gives a live one.

### Terminal → Data: profile page (2026-11-12)
The FOMO-style `/me` and `/u/<handle>` pages read `/wallets/:w/pnl` today. Each section below shows an empty state until its field or endpoint exists:
- **PnL history** for the portfolio chart: `GET /wallets/:w/pnl/history?window=24h|7d|30d|all` → `{ points: [{ t: ISO, value_usd, pnl_usd }] }`, roughly 50–200 points per window.
- **Wallet trades** for the Transactions tab: `GET /wallets/:w/trades?side=buy|sell&min_usd=&cursor=` → `{ items: [{ tx, token, symbol, image_url, side, amount_usd, token_amount, market_cap_usd (at trade time), at }], next_cursor }`.
- **`decimals`** on each entry in `positions`. Until then, held amounts assume 18 decimals.
- **ETH/USD price** (for example `eth_usd` on `/stats` or `GET /prices/eth`). Until then the cash card reads DexScreener's WETH pair.
- **`avg_hold_seconds`** in the pnl `summary`. The header's "Avg hold" shows "—" until it exists.

### Terminal → Agents: profile page (2026-11-12)
The profile uses `GET /v1/members/:ref`, `PATCH /me`, `POST /me/avatar|banner`, follows, `/me/relationship/:ref`, `/suggestions` and `/members/:ref/callouts`, all from `claude/agents-profiles`. Until that branch is live, `/u/<handle>` shows "check back soon" and the rail and feed show empty states. Callouts can optionally carry `entry.marketCapUsd` and `resultPct`; the feed shows "$X at $Y MC" and "+Z% since" from them.

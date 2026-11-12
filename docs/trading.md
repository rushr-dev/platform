# Trading and the platform fee

Status 2026-11-12: research done, founder decisions in (below), scaffold in `packages/trade`, `contracts/` and `/swap`. Nothing here has been deployed. The treasury is the founder's EOA (see the known risk below).

## Beta trading v0 (2026-11-12)

**What it is:** quick buy and sell with **no confirmation popup**:
- **Signing:** client-side, in the user's own **Privy embedded wallet**, with `sendTransaction(tx, { uiOptions: { showWalletUIs: false } })`. Rushr's servers hold **no signing key for humans**.
- **Route:** through **Uniswap's audited Universal Router**, with our fee in the same tx: `TRANSFER` on buys, `PAY_PORTION` + `SWEEP` on sells, recipient = the user.
- **Contracts:** no RushrRouter or RushrPonsRouter. Those stay for agents and offline one-click, after the audit.
- **Fee and treasury:** 0.5% (0.45% referred), paid to the treasury `0x447a…5E40`.

### Pieces
| Where | What |
| --- | --- |
| `packages/trade/src/quick.ts` | `quickBuy` / `quickSell` / `prepareQuickTrade` build the exact wallet calls. Sells add `approve(Permit2)`, then `Permit2.approve(Universal Router, 30 days)`, then the swap. Guardrails are applied and the calls are simulated before sending (`eth_simulateV1` from the user's address), with gas taken from the simulation |
| **One Privy setup** (Terminal's) | `components/terminal/auth/privy-host.tsx` loads Privy lazily (email and EVM wallet login; an embedded wallet for every user on chain 4663; wallet UIs off) and fills `lib/auth`. The trade UI uses only `useAuth()`, `auth.login()` and `auth.sendTransaction()`, so it imports no Privy and adds nothing to page bundles. Settings come from Terminal's `lib/settings` / `/settings`: buy and sell presets, quick-buy amount, slippage (auto or fixed), per-trade cap |
| `apps/web/components/trade/trade-box.tsx` | `TradeBox` for the token page: buy/sell, presets, % sells, quote (receive, min, fee, route), warnings and blockers, the "I understand" toggle, a link to `/settings`, and tx status with an explorer link |
| `apps/web/components/trade/quick-buy-button.tsx` | `QuickBuyButton` for trenches rows: one click (the `/settings` quick-buy amount), then quote, guards and a silent send |
| `apps/web/components/trade/use-quick-trade.ts` | The hook: quote, honeypot/tax probe, guards, then `auth.sendTransaction` for each call in order and wait for each receipt. As soon as the swap is broadcast it calls `recordTrade(txHash)`: a best-effort `POST /v1/trades` (Data's ledger, Privy bearer token), retried once on `404 tx_not_found` |
| `apps/web/components/trade/index.ts` | Exports `TradeBox`, `QuickBuyButton`, `isSwapEnabled`, `tradingAvailable` and `TradeToken` for Terminal to place. Everything renders nothing unless `NEXT_PUBLIC_SWAP_ENABLED=1` and a Privy app id are set |
| `apps/web/components/trade/csp.ts` + `apps/web/middleware.ts` | Strict CSP with a per-request nonce on `/trenches`, `/token/*`, `/settings`, `/me`, `/u/*` and `/swap`. Privy is live on all of them, so all get the same CSP, and `/settings` is rendered per request so the nonce reaches its scripts |
| `packages/trade/scripts/quick-sim.ts` | End-to-end simulation of the wallet calls on live state |

### Guardrails (client)
- **Per-trade cap:** on the ETH side (buy input, expected sell output), from Terminal's `/settings`. Note: Terminal's default is 0.5 ETH, while the founder's spec said 0.25 ETH; the default lives in `lib/settings.ts` (Terminal).
- **Slippage:** automatic. 5% base; +3% for tokens under 1 h old, +5% under 10 min; +3%/+5% for 5-min moves above 20%/50%; plus extra for impact above 2%. Capped at 15%, then the measured token tax is added on top, Terminal's `/settings` chooses **auto** (this) or a **fixed** percentage.
- **Quote freshness:** quotes expire after 10 s and are refreshed automatically before sending.
- **Safety:**
  - High-risk tokens need an "I understand" toggle once per token (remembered per browser).
  - The buy→sell honeypot probe blocks tokens that can't be sold back.
  - Tax above 5% shows a warning, and medium risk shows its verdict.
- **Routing safety:**
  - **PONS tokens still on their curve are "tradable after graduation", even when other pools exist.** A curve token was found live with a stray **89%-fee** v4 pool.
  - Pools with a venue fee above 10% are never routed; above 3% shows a warning.
  - Price impact above 30% is a hard block.
- **Balances:** ETH for amount plus gas (estimate ×1.5); token balance for sells.
- **Status:** signing, then pending with an explorer link, then success or failure with an explorer link. Cancellations and revert reasons are shown in plain words.

### Security for silent client-side signing
- **CSP** on the terminal and trade pages:
  - scripts: our own (`'self'`, plus the nonce for Next's inline bootstrap; no `'unsafe-inline'`), Cloudflare Turnstile (Privy) and the Cloudflare Web Analytics beacon, which Cloudflare injects at the edge without our nonce (hence no `'strict-dynamic'`)
  - frames only from Privy, WalletConnect verify and Turnstile
  - connections only to our API and live socket (v1/v2), the public chain RPC, DexScreener, Privy, WalletConnect and Cloudflare Web Analytics
  - images same-origin (icons and X avatars via `/api/img`)
  - `frame-ancestors 'none'`, `object-src 'none'`

  Checked on a production build with no CSP violations on `/trenches`, `/token/<PONS>`, `/settings`, `/swap` or the landing page (which has no CSP). The live feed shows "live", Privy's embedded-wallet iframe loads, the sign-in modal opens, and a socket to a non-allowlisted host is blocked.
- **No third-party scripts** on trade pages. Our bundles only.
- **Privy allowed origins:** the founder's dashboard is limited to `https://rushr.trade` and `https://app.rushr.trade` (seen in Privy's `frame-ancestors`). Add localhost only for development (see the to-dos).
- **Keys:** the per-trade cap and the user's own key are the limits. An XSS on our origin could still trade within the cap, which is why the CSP is strict. Users can export their key at any time from Privy.

### Verified
- `quick-sim.ts` on live state (public RPC, nothing signed):
  - **PONS:** quick buy, then quick sell with approvals, in one simulated block. Tokens received equal the quote to the wei, the treasury gets exactly 0.00005 ETH, and the sell pays ETH to the user.
  - **lift.fun token:** buy passes. Selling after a buy was proven earlier by the probe.
  - **PONS curve token:** blocked with "tradable after graduation".
- 72 unit tests.
- Production build with the flag on, on Terminal's single Privy setup:
  - the trade box quotes for signed-out visitors (0.01 ETH ≈ 136 PONS, fee 0.00005 ETH) with Terminal's presets and cap
  - "Sign in to trade" opens the Rushr sign-in modal
  - no CSP violations

  With the flag off, `/swap` is a 404 and no trade UI renders.

### Trade ledger (Data)
Built on Data's branch (3e2f1c8). It is **not live yet**: it needs migration 0008 (founder approval, batched with 0006 and 0007), `AGENTS_ENABLED`, and a small change to Agents' key guard. It mounts in Agents' `/v1`.
- `POST /v1/trades`
  - Auth: Privy bearer, or an agent key with scope `trade`.
  - Body: `{ txHash, chainId: 4663, source? }`.
  - Returns 202 `{ id, status: 'submitted' }`, idempotent per hash.
  - Errors: 404 `tx_not_found` until the node knows the tx (retry once), 403 `not_your_tx`, 400 `bad_tx_hash` / `bad_chain`.
  - There is no referral code in the request: the referrer always comes from the member's signup attribution (Agents' `referrals`).
- **Confirmation** (queue, ~10 min of retries) fills:
  - status, side, token, pool, venue, quote asset
  - amounts. Buy: input including the fee, tokens out. Sell: tokens in, quote out after the fee.
  - `fee_amount` = what the treasury actually received (call trace for ETH, Transfer logs for ERC-20)
  - `fee_bps` measured on the notional
  - referral fields: 20% accrual
  - `flags[]` when anything is off (e.g. `fee_bps_48.2_expected_45`, `no_fee`, `reverted`)
- Reading: `GET /v1/me/trades?before=&limit=` and `GET /v1/me/referrals/accrued`.

The web client posts as soon as the swap is broadcast and ignores errors until the endpoint is live. A real end-to-end check needs the founder's first live trade.

### Founder to-dos in the Privy dashboard (app `cmwdhafq101190hjt99ym9pah`)
1. **Allowed origins:**
   - production: `https://rushr.trade` and `https://www.rushr.trade` (keep `https://app.rushr.trade` if used)
   - development only: `http://localhost:3010` (Terminal) and `http://localhost:3012` (Swap)

   Remove localhost before launch, or use a separate dev app client.
2. **Login methods** (founder decision): **email** and **EVM wallet** (MetaMask, WalletConnect) only. No X login, so no X OAuth setup. This is already the configuration in Terminal's `privy-host.tsx`; make the dashboard match.
3. **Embedded wallets (Ethereum):**
   - enable, with **"Create on login: users without wallets"** (the code also sets this)
   - keep **key export enabled**, since users must be able to export
   - leave the wallet-UI default; the trade code hides the UI per transaction
4. **Chains / RPC:** nothing to set. Robinhood Chain 4663 is configured in code as a custom chain with the public RPC. **No gas sponsorship** (users pay gas in ETH).
5. **Optional, recommended before volume:** MFA (passkey or TOTP) required for key export; a custom auth domain with HttpOnly cookies.
6. **Deploy env** (build time):
   - `NEXT_PUBLIC_PRIVY_APP_ID=cmwdhafq101190hjt99ym9pah`
   - `NEXT_PUBLIC_SWAP_ENABLED=1` (only when ready to open trading)

   The app secret stays server-only (`.dev.vars.privy`, Worker secret) and isn't needed for v0.
7. **First real trade (founder only):**
   - log in on a build with the flag on and fund the embedded wallet with a little ETH on Robinhood Chain
   - buy 0.001–0.005 ETH of a liquid token (e.g. PONS) from the token page
   - check the explorer link; the treasury receives 0.5%
   - sell 100%: the first sell sends two approval transactions, then the swap

## Decisions (founder, 2026-11-12)

| Question | Decision |
| --- | --- |
| **Rate** | **0.5%** of the trade, buys and sells: fomo parity, undercuts Axiom (~1%). It's config (`feeBps: 50`), not a constant. |
| **Which side** | Always the **quote side** (ETH, WETH or USDG): taken from the input on buys, from the output on sells. The treasury only receives ETH or USDG, and a token's own tax can't shrink or block the fee. |
| **Collection, Uniswap v2/v3/v4** (including Doppler, lift.fun and other hooked v4 pools) | **Primary path.** Uniswap's audited **Universal Router**, no custom contract. Buys: `TRANSFER(ETH, treasury, fee)` from `msg.value`, then swap the rest. Sells: swap into the router, `PAY_PORTION(ETH, treasury, bps)`, `SWEEP(ETH, user, minOut)` (the pattern Uniswap's interface fee used). |
| **Collection, PONS bonding curves** | `contracts/src/RushrPonsRouter.sol`, fully tested, **undeployed until an independent review** (checklist below). Until then, curve routes are quoted but not buildable. |
| **Treasury** | The founder's own wallet, an **EOA**: `0x447a590b70cd55Cc6B62CEaf79D4c6c09A955E40` (founder decision 2026-11-12; EIP-55 checksum valid; no code and nonce 0 on 4663). It's `RUSHR_TREASURY`, the default `feeRecipient` in `packages/trade`. The routers can move it to a Safe later **only through the guardian's timelock** (queue, wait `delay`, activate, events; no owner, no instant change). **Known risk:** see below. |
| **Referral** | **Off-chain accounting.** A referred trader pays **10% less fee** (0.5% → **0.45%**, charged on-chain as a lower rate). The referrer accrues **20% of the fee actually collected** in our ledger. Payouts aren't built yet. |
| **Other v3 forks** (Ramses, Aero CL, up, Topaz, Nami, giga, robinswap) | Not routable through the Universal Router, which knows only Uniswap's factories (verified in its bytecode). Phase 2. |
| **Agents** | Agents trade through the same code: `packages/trade` is pure functions that return unsigned transactions (`prepareSwap`), usable from a server or agent runtime, not only from `/swap`. |
| **UI** | The fee is a line in every quote ("Rushr fee 0.5% · 0.00005 ETH"; referred: "0.45%, 10% referral discount"), next to venue fees (pool fee, PONS curve fee and creator tax) and any measured token tax. "Min received" is net of everything. The rate also goes on the terms page. |

Universal Router deployment: Uniswap's official list for 4663 has v2.1.2 at `0x204faca1…0498` (the default). The core registry's `0x8876…0904` is also a Universal Router with the same factories embedded, and it's config.

### Known risk: EOA treasury
- **Risk.** All fees collect in a wallet controlled by one private key. If that key is lost, phished or compromised, accumulated fees are lost, and fees keep flowing to the attacker until the routers' treasury is changed. Changing it takes at least the timelock `delay`; Universal Router paths change instantly in config.
- **Mitigations.**
  1. Keep the key on a **hardware wallet**, used only for the treasury and never connected to dapps.
  2. Do **regular sweeps** to cold storage, e.g. daily, or whenever the balance passes a threshold.
  3. **Migrate to a Safe before volume grows.** Deploy a Safe on Robinhood Chain. Each router's guardian queues it with `queueTreasury(safe)` and anyone runs `activateTreasury()` after the delay. Then update `RUSHR_TREASURY` in `packages/trade` for the Universal Router path.
  4. Monitor treasury inflows against the ledger (`sum(fee_amount)` per day).
- **Audit checklist:** covered in `contracts/REVIEW.md` (treasury timelock and EOA treasury).

## Referral ledger (off-chain)

How it works:
- **At quote time:** a `SwapRequest` may carry `referral: { referrer, code? }` (resolved server-side from the trader's signup) and `source: { kind: 'web' | 'agent' | 'api', id? }`.
- **Fee rate:** `effectiveFeeBps` = base − ⌈base × 10%⌉ = **45 bps** when referred. The Universal Router plan uses that rate (`TRANSFER` amount, `PAY_PORTION` bips). RushrPonsRouter has an immutable `referralFeeBps` and a `referred` flag.
- **Recording:** `draftTradeRecord(quote)` → store at submit. `confirmTradeRecord(record, receipt)` → status `confirmed`, with `feeAmount` = **fee actually received by the treasury** (from the receipt's transfers, same analysis as `analyzeSwapTransfers`) and `referrerAccrual` = 20% of that.
- **Payouts (later):** sum confirmed `referrer_accrual` by referrer and fee token, minus what has been paid.

Fields recorded per trade (`TradeRecord` in `packages/trade/src/referral.ts`). This is a proposed table; `packages/db` is owned by Data, so this is a request, not a migration:

```sql
create table trades_ledger (
  id                  bigserial primary key,
  chain_id            int not null default 4663,
  status              text not null,              -- quoted | submitted | confirmed | failed
  tx_hash             text unique,                -- null until submitted
  block_number        bigint,
  ts                  timestamptz not null,
  trader              text not null,              -- lowercase address
  source_kind         text not null,              -- web | agent | api
  source_id           text,                       -- agent / API client id
  side                text not null,              -- buy | sell
  token               text not null,
  quote_asset         text not null,              -- ETH | USDG
  venue               text not null,              -- uniswap-v4 | uniswap-v3 | uniswap-v2 | pons-curve
  pool_id             text not null,
  router              text not null,
  amount_in           numeric(78,0) not null,
  amount_out          numeric(78,0) not null,     -- expected, then actual
  fee_token           text not null,              -- 0x0 (ETH) or USDG
  base_fee_bps        int not null,               -- 50
  fee_bps             int not null,               -- 45 when referred
  fee_amount          numeric(78,0) not null,     -- actual once confirmed (payout basis)
  referrer            text,
  referral_code       text,
  referral_discount   numeric(78,0) not null default 0,
  referrer_share_bps  int not null default 0,     -- 2000
  referrer_accrual    numeric(78,0) not null default 0
);
create index on trades_ledger (referrer, status) where referrer is not null;
create index on trades_ledger (trader, ts desc);
create table referrals (                          -- who referred whom (first touch, immutable)
  referee     text primary key,
  referrer    text not null,
  code        text,
  created_at  timestamptz not null default now()
);
```

The chain is the source of truth for the fee itself: the treasury's inflows can be reconciled against `sum(fee_amount)` per day.

## How others charge (researched 2026-11-12)

Figures marked **[3P]** come from third-party or affiliate pages only. Fees change often (Uniswap went 0.15% → 0.25% → 0 within about two years), so treat every figure as perishable.

| Product | Rate | Side | On-chain mechanism | Referral and rebates | Sources |
| --- | --- | --- | --- | --- | --- |
| **GMGN** | 1% flat, buy and sell; invite codes reportedly 0.7–0.8% [3P] | Quote asset in their example (1 SOL trade → 0.01 SOL) | Not documented for EVM | Not in official docs | [docs.gmgn.ai fees](https://docs.gmgn.ai/index/gmgn-fees-settings), [gmgn-skills swap](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-swap/SKILL.md) |
| **Axiom** | ~1% base, volume cashback brings the net to ~0.95–0.75% [3P] | **Observed on Robinhood Chain: input side of a buy** | **Own router**, `axiomTrade(bytes,bytes[],uint256)` on proxy `0x9689…8341` (implementation `0x1ee9…9760`), with Universal-Router-style commands. Fee sent in the same tx to vault `0x6fb4…b86c` via `deposit(bytes)` | Cashback tiers [3P] | Tx `0xa47a799a…c864` (traced below), [3P article](https://medium.com/@crypto-deploy/axiom-trade-fees-what-you-actually-pay-and-how-to-pay-less-0df290e57f7b) |
| **fomo** | 0.5% spot on Base, BNB, Monad, Robinhood Chain; 0.45% with referral; ~$0.95 minimum on small trades [3P] | Not found | Not found | Referrer gets 25% of referee fees [3P] | [fomoappguide](https://fomoappguide.com/referral), [datawallet](https://www.datawallet.com/crypto/fomo-referral-code) |
| **Photon** (Base) | 1%, 0.9% with referral [3P] | Not found | Not found | ~10% off with referral [3P] | [basesniperbots](https://basesniperbots.pages.dev/reviews/photon) |
| **BullX** | 1% (official, Solana docs) | **Buys: from input** (5 SOL → 4.95 swapped). **Sells: from output** | Same tx | 0.9% with referral [3P] | [bullx docs](https://bullx.gitbook.io/bullx-neo-docs/fees-and-gas) |
| **Banana Gun** | 0.5% manual and limit on Ethereum; 1% autosniper and other chains | Not documented | Own router ("Banana Gun: Router 2" on Etherscan) | Referral 10% base, plus time and volume boosts; cashback 15/20/25/30% by lifetime volume, paid in BANANA | [blog](https://blog.bananagun.io/blog/the-best-trading-bot-for-meme-coins-airdrops-and-pre-migration-sniping-in-2025), [referrals](https://banana-gun.gitbook.io/banana-gun/get-started/referrals.md), [rewards](https://banana-gun.gitbook.io/banana-gun/get-started/rewards.md) |
| **Maestro** | 1% buy and sell | — | **EVM: not in the swap tx.** Maestro accrues what each account owes and later sends one transfer from the wallet to `0xB099…7397`. Has its own Router 2 (exploited once, 610 ETH refunded) | 25% lifetime referral; cashback 15–30% | [monetization](https://docs.maestrobots.com/sniper/monetization.md), [referral](https://docs.maestrobots.com/sniper/referral-program.md), [cashback](https://docs.maestrobots.com/sniper/cashback.md) |
| **Sigma** | 1% (other sources say 0.5–0.8%) [3P] | Not found | Not found | Revenue share, % not found | [3P](https://solanatradingbots.com/compare/banana-gun-vs-sigma/) |
| **Uniswap interface** | 0.15% (Oct 2023, majors only) → 0.25% (Apr 2024, most pairs) → **0% since 2025-12-27** | **Always the output token** | Universal Router: swap output into the router, `PAY_PORTION(token, recipient, bips)` (pays `balance × bips / 10000`), then `SWEEP` the rest to the user. v2.1.1 adds `PAY_PORTION_FULL_PRECISION` (0x07, 1e18 precision) | — | [Payments.sol](https://github.com/Uniswap/universal-router/blob/main/contracts/modules/Payments.sol), [The Block 0.15%](https://www.theblock.co/post/257798/uniswap-to-charge-0-15-to-swap-certain-tokens-on-web-interface-and-wallet), [The Block 0.25%](https://www.theblock.co/post/288170/uniswap-labs-hikes-swap-fee-to-25-from-15-on-trades-through-interface), [fee sunset](https://developers.uniswap.org/docs/changelog/completed-notifications/sunset-of-api-key-based-fees-and-fields) |
| **MetaMask Swaps** | 0.875% | Included in the quote | Aggregator contract | Promotions only | [support](https://support.metamask.io/trade/metamask-fees/) |
| Aggregator APIs | Integrator sets it: 0x `swapFeeBps` (≤10%, fee token = buy or sell token), 1inch `fee` (≤3%, source token) + `referrer`, Kyber `chargeFeeBy` in/out, LI.FI `fee` | Configurable | Inside the aggregator's router | — | [0x](https://docs.0x.org/evm/0x-swap-api/guides/monetize-your-app-using-swap.md), [Kyber](https://docs.kyberswap.com/developer-guide/aggregator-api/aggregator-api-specification/evm-swaps), [LI.FI](https://docs.li.fi/faqs/fees-monetization.md) |

### Axiom on Robinhood Chain, traced
A PONS-curve buy in tx `0xa47a799a20a614695d5ed3b2885f8c8c62b7a8ff7181eb1d967a9f6acf7cc864` (debug trace, 2026-11-12). The user sent 0.031 ETH to Axiom's router `0x9689992f…8341` (`axiomTrade`, delegatecall to `0x1ee9927a…9760`). The router then:
1. Sent 0.001 ETH to `0x56931968…55bd`. This is unidentified: a priority or tip setting, or a flat fee.
2. Read `getLaunchedToken(token)` on the PONS factory and the token balance.
3. Called `curve.buy{value: 0.02972 ETH}(0.02972 ETH, 0, router)`. The tokens came to the router, which then sent them to the user.
4. Paid **0.000297 ETH = 1.0% of the swapped amount** to `0x6fb4460e…b86c` via `deposit(bytes)` (a fee vault, emitting `0x393c1cce…`).
5. Refunded the dust (0.000003 ETH).

So Axiom takes ~1% from the input on buys, in the same tx, through its own router, with `minOut = 0` passed to the curve and its own balance check afterwards.

### Patterns
- **Rate:** 1% flat is the norm for trading terminals and bots. Cheaper tiers sit around 0.5% (fomo, Banana Gun manual ETH trades). Wallets and frontends are lower (MetaMask 0.875%, Uniswap 0.15–0.25%, now 0).
- **Side:** native or quote asset. Input on buys, output on sells.
- **Mechanism:** bots use their own routers and take the fee in the same tx. Maestro on EVM bills afterwards with a separate transfer. Universal Router frontends use `PAY_PORTION` + `SWEEP`.
- **Rebates:** referral 10–25% of fees, often with a ~10% discount for the referee; volume-tiered cashback of 15/20/25/30% (Maestro and Banana Gun use the same ladder).
- **Taxed tokens:** bots simulate a sell (honeypot check), cap buy and sell tax, raise slippage by the measured tax (Maestro "Smart Slippage"), and Banana Gun offers anti-rug front-run sells. No official source says they use the `supportingFeeOnTransfer` router functions.
- **Disclosure:** mostly a flat rate in the docs. MetaMask and Uniswap show it in the quote, which is what we should do.

## Robinhood Chain specifics (verified on-chain 2026-11-12)

- **Uniswap's official deployments for 4663** (`developers.uniswap.org/deployments.json`):
  - v4 PoolManager `0x8366…0951`, V4Quoter `0x8dc1…8f94`, StateView `0xf333…673b`
  - v3 factory `0x1f7d…2efa`, **QuoterV2 `0x33e8…a9e7`**, SwapRouter02 `0xcaf6…5cb2`
  - v2 factory `0x8bce…937f`, Router02 `0x89e5…9eba`
  - Permit2 `0x0000…8ba3`, **UniversalRouter v2.1.2 `0x204f…0498`**
- **Universal Router reach:** both routers' bytecode embeds only the *first* v3 factory (`0x1f7d…`) and v2 factory (`0x8bce…`), the standard Uniswap init code hashes, and the v4 PoolManager. Pools of the second v3/v2 factories in the registry (`0xe7fe…`, `0x0d1e…`) and of other forks are not reachable through it.
- **v4 pool keys:** `PositionManager.poolKeys(bytes25 poolId)` returns the key for pools that ever had a PositionManager position (works for PONS's main pool). Hook-managed pools (Doppler) may not be registered there. Their key is in the PoolManager `Initialize` event, which the indexer already has. **Request to Data:** expose `{currency0, currency1, fee, tickSpacing, hooks}` per pool on the API.
- **PONS curves** (per-token contract, factory `0x7ed5…ec7e`, `getLaunchedToken(token)` → `(token, curve, creator, …)`):
  - `buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)`.
  - `sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)`: pulls tokens with `transferFrom` from `msg.sender`, so it needs an ERC-20 approve to the curve (the revert without one is `ERC20InsufficientAllowance`).
  - **The curve already charges 2.5% per trade:** `feeBps` = 100 (1% protocol, 30% of which is the protocol share) plus `creatorTaxBps` = 150 (1.5% creator). Both show in the `ponsBuy`/`ponsSell` event data.
  - **Snipe tax:** `snipeTaxStartBps` = 9900 (**99%**) decaying over `snipeTaxSeconds` = 3 after launch; `currentSnipeTaxBps(address)` reads it.
  - Graduation at `graduationThreshold` = 4.2 ETH, then the token trades in a v4 pool with the PONS v2 hook (Universal Router path).
- **eth_simulateV1** is supported by our RPC, including `traceTransfers` (native ETH moves appear as `Transfer` logs from `0xeeee…eeee`). It lets us simulate approve → swap → sell sequences with no signatures and no state changes, which is how the scaffold verifies routes and measures token tax.
- **MEV:** Robinhood Chain is an Arbitrum Orbit (Nitro) chain with a sequencer, so there's no public mempool to sandwich from in the usual Ethereum sense. We don't need an "anti-MEV" bribe product. Slippage limits still matter: other txs land between quote and inclusion. Still to confirm: whether Timeboost or another express lane is enabled.

## Taxed and fee-on-transfer tokens

1. **Measure, don't trust:** before showing a quote for an unknown token, simulate a **buy and then a sell** of the received amount in one `eth_simulateV1` block (with the approvals as extra calls, no signatures). Compare what each step actually transferred with what the pool quoted. The result:
   - buy tax %
   - sell tax %
   - "can't sell" (honeypot) if the sell reverts
2. **Slippage:** default slippage plus the measured tax. Warn above 5% tax, block by default above 50% or on a failed sell, with an explicit override.
3. **Venue fees are not taxes:** pool fees and the PONS curve's 2.5% are known and shown as venue fees. The PONS snipe tax is shown as a warning during the first seconds after launch.
4. **Routing:** Universal Router v2 swaps handle fee-on-transfer input (they read the pair's balance). v3 and v4 don't support fee-on-transfer input properly, so for taxed tokens we prefer v2 or reject. Our fee is always on the quote side, so a token tax never shrinks it.

## What we show the user (quote panel)
- You pay / you receive (estimated), **min received** (after slippage, our fee, venue fees and measured tax)
- **Rushr fee:** `0.5% · 0.00005 ETH` (referred: `0.45%`, with the discount shown), always visible, never folded into "price impact"
- Venue: e.g. "Uniswap v4 · 1.01% pool fee" or "PONS curve · 1% fee + 1.5% creator tax"
- Price impact, measured buy and sell tax, honeypot or snipe-tax warnings
- Route: venue, pool and router address, linked to the explorer
- The terms page states the rate, the side it's taken from and that Rushr is non-custodial

## Scaffold (`packages/trade`, `contracts/`, `/swap`)

Status 2026-11-12. Nothing is signed or broadcast anywhere: verification is unit tests, `eth_simulateV1` and a local Foundry fork.

### `packages/trade`
| Module | What it does |
| --- | --- |
| `addresses.ts`, `chain.ts` | Trading contracts for 4663 from Uniswap's official list, the PONS factory, and a viem chain with multicall3 |
| `config.ts` | `feeBps` (default **50**, capped at 300), `referralDiscountBps` (1000 = 10% of the fee), `referrerShareBps` (2000), `feeRecipient` (default `RUSHR_TREASURY`, the founder's EOA), `universalRouter`, `ponsRouter` (null until deployed). `assertSignable` refuses a placeholder treasury. One-click trading is gated separately by `assertOneClickAllowed` (RushrRouter deployed **and** audited), and the web UI by `NEXT_PUBLIC_SWAP_ENABLED` |
| `referral.ts` | Effective rate, referrer accrual and discount; `TradeRecord` draft and confirm for the off-chain ledger |
| `agent.ts` | `prepareSwap(client, request, opts)` for servers and agents: best route → unsigned tx, approvals, command list, ledger record, optional simulation. `toJsonSafe` for tool and HTTP output. No browser globals, no keys |
| `fees.ts` | Fee math: fee off the input on buys, off the gross output on sells (identical to `PAY_PORTION`), slippage minimums, tax-adjusted slippage |
| `pools.ts` | Discovery: PONS curve via `getLaunchedToken`; Uniswap v3 (4 fee tiers) and v2 on WETH/USDG; v4 from the API's `main_pool` (PositionManager `poolKeys`, falling back to the `Initialize` event for hook-managed pools), indexer-supplied keys and standard hookless pools, checked with StateView |
| `api-pools.ts` | Adapter for the indexer's `GET /tokens/:a/pools` (`{ pools: [...] }`, Data branch 0c61362). v4 keys feed discovery only if `keccak256(abi.encode(key))` equals the row's pool id, so a bad response can't redirect a swap. Busy pools on venues we can't route yet (Ramses, Aero…) become a one-line disclosure. Returns `null` (falls back to on-chain discovery and `main_pool`) while the endpoint isn't deployed. Used by `prepareSwap`, `/swap` and the live script |
| `quote.ts` | V4Quoter, QuoterV2, v2 reserve math, PONS curve math (exact to the wei); price impact from spot; ranks by what the user receives and prefers routes we can build |
| `universal-router.ts` | Typed encoder for Universal Router commands and v4 actions. **Note:** the routers on 4663 (v2.1) take an extra `uint256[] maxHopSlippage` on v2/v3 swaps and an extra `uint256` in v4 `ExactInputSingleParams`. The older layouts revert or misbehave (found by simulation, matched against live txs) |
| `build.ts` | Unsigned tx plus required approvals (ERC-20 → Permit2, then `Permit2.approve` or a signed `PermitSingle` as `PERMIT2_PERMIT`) |
| `permit2.ts` | PermitSingle EIP-712 typed data (for the user's wallet to sign) and allowance reads |
| `simulate.ts` | `eth_simulateV1` with `traceTransfers`: approvals and swap in one block, received amount, fee actually paid to the treasury, transfer tax measured from the token's own `Transfer` logs, and a buy→sell honeypot probe |
| `errors.ts`, `revert.ts` | `TradeError` codes for the UI. Revert decoding unwraps `ExecutionFailed`. RPC URLs are scrubbed from messages |

Fee command plans (Universal Router):
| Trade | Commands |
| --- | --- |
| Buy, native-ETH v4 pool | `TRANSFER(ETH→treasury, fee)` · `V4_SWAP(SWAP_EXACT_IN_SINGLE, SETTLE(router), TAKE_ALL)` |
| Buy, WETH v2/v3/v4 pool | `TRANSFER` · `WRAP_ETH` · swap from router balance |
| Buy with USDG | `PERMIT2_TRANSFER_FROM(USDG→treasury, fee)` · `PERMIT2_TRANSFER_FROM(USDG→router)` (v4) or swap with `payerIsUser` (v2/v3) |
| Sell to ETH/WETH | swap into router · (`UNWRAP_WETH`) · `PAY_PORTION(ETH→treasury, feeBps)` · `SWEEP(ETH→user, minNet)` |
| Sell to USDG | swap into router · `PAY_PORTION(USDG)` · `SWEEP(USDG, minNet)` |
| PONS curve | `RushrPonsRouter.buy/sell` (not deployed) |

Verified live (`pnpm --filter @rushr/trade simulate`, about 20–40 RPC calls per token):
- PONS buy and sell through Uniswap v3, v2 and v4 (ETH) and v4 (USDG), on both Universal Routers. Tokens received equal the quote to the wei, and the treasury receives exactly 0.5% (also verified at 1% earlier, and 0.45% for a referred buy on the /swap page).
- A lift.fun token (hooked v4 pool): buy is exact, and the buy→sell probe sells back. Its sell can't be quoted at current state, because the launch liquidity is one-sided until someone buys.
- PONS curve quote equals the curve's own `buy()` output to the wei.

Tests: `pnpm --filter @rushr/trade test` covers fee math, config guards, encodings (byte layouts matched to live txs), command plans for every venue and side, PONS math against on-chain values, transfer and tax analysis, and revert decoding (36 tests).

### `contracts/RushrPonsRouter.sol` (not deployed; Uniswap routes stay the primary path)
PONS curve buy and sell with the fee in ETH.
- **Rates:** immutable `feeBps` (50) and `referralFeeBps` (45), with `referralFeeBps ≤ feeBps ≤ 300`. The caller picks the rate with `referred`. That is no weaker than today: anyone can always call the curve directly and pay no Rushr fee, so the fee is collected by our frontends and agents, not enforced against the user.
- **Graduation refunds:** a buy that completes the curve gets the unused ETH back from PONS. The router then charges the fee only on ETH actually spent (`fee / (spent + fee) = bps`) and refunds the rest to `msg.sender` in the same tx. Found by simulation: without this, refunds would have been stranded in the router.
- **Sells:** pulls tokens with `transferFrom` and measures what arrived (fee-on-transfer safe). Approves the curve for exactly that amount, then resets the approval to 0. Returns unsold tokens. Fee comes off the ETH output; `minQuoteOut` is checked on the net.
- **Safety:** no owner, no upgrades, no arbitrary calls (only the immutable factory, the curve it reports for the token, the token and the treasury). The treasury changes only through the guardian timelock (`TreasuryTimelock`). Reentrancy lock. ETH accepted only mid-trade. Deadline.

Tests (`cd contracts && forge test`): 20 unit and fuzz tests with mocks cover:
- exact fee math at both rates
- refund accounting at graduation, including a fuzz test that ETH is never stranded
- slippage on buy, on sell net, and after a transfer tax
- unsold-token return, unknown and graduated curves, deadline and zero-amount guards
- reentrancy, a rejecting treasury, and stray ETH

Plus 4 fork tests on a real PONS curve (`ROBINHOOD_RPC_URL=… forge test --match-contract Fork`):
- 0.01 ETH buy and sell: exactly 0.5% each way, nothing left in the router
- a referred buy pays 0.45%
- slippage reverts at quote + 1
- a 20 ETH buy that graduates the token: 3.79 ETH spent, the rest refunded, fee exactly 0.5% of what was paid

#### Review checklist (before any deployment)
It lives with the code so it ships in the public contracts repo: [`contracts/REVIEW.md`](../contracts/REVIEW.md). It covers RushrRouter and RushrPonsRouter.

### Using it from a server or agent
```ts
import { createPublicClient, http } from 'viem';
import { prepareSwap, robinhoodChain, toJsonSafe } from '@rushr/trade';

const client = createPublicClient({ chain: robinhoodChain, transport: http(RPC_URL), batch: { multicall: true } });
const prepared = await prepareSwap(client, {
  side: 'buy', token, quoteAsset: 'ETH', amountIn: 10n ** 16n, trader: agentWallet, slippageBps: 100,
  referral: referrerOf(agentOwner), source: { kind: 'agent', id: agentId },
}, { config: { feeRecipient: TREASURY }, simulate: true, forSigning: true });
// prepared.approvals (if any), then prepared.tx: signed by the agent's own wallet/signer, never by this package.
// Store prepared.record (status 'submitted' + txHash), confirm it from the receipt.
return toJsonSafe(prepared);
```

### `/swap` test page
`apps/web/app/(app)/swap` with `components/trade/*`:
- connect an injected wallet (EIP-6963; accounts only)
- token, buy or sell, ETH or USDG, slippage
- all routes with impact, and the fee breakdown (Rushr fee, venue fees, minimum received, warnings)
- **Simulate:** approvals and swap via `eth_simulateV1`, the ETH balance topped up inside the simulation only, plus the buy→sell probe
- the unsigned tx and approvals shown for inspection

Signing is disabled. Quotes use the **public** Robinhood RPC from the browser (it supports `eth_simulateV1` and CORS), so no secret ships and Alchemy isn't billed.

### Open items
- Treasury multisig from the founder: set `feeRecipient` and enable signing behind `assertSignable`.
- Referral payouts and the `trades_ledger` / `referrals` tables (Data owns `packages/db`).
- Independent review of `RushrPonsRouter` against the checklist above.
- Multi-hop routes (e.g. token → USDG → ETH) and split routes. Today it's the best single pool.
- Ramses, Aero and the other v3 forks: adapter in the fee router (phase 2).
- `/tokens/:a/pools` (Data, built, awaiting the migration approval): already wired with a fixture-tested adapter. Once deployed, check one Doppler token live with `pnpm --filter @rushr/trade simulate <token>`.
- Integrating the trade box into the terminal's token page (Terminal stream) on top of `@rushr/trade`.

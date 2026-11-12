# Trading and the platform fee

Status: research and recommendation (2026-11-12), plus the scaffold in `packages/trade`. Nothing here has been deployed or signed. Fee rate and treasury are placeholders until the founder decides.

## Recommendation in one screen

| Question | Recommendation |
| --- | --- |
| **Rate** | **1%** of the trade, buys and sells. This matches GMGN, Maestro, Photon, BullX and Axiom, which on-chain takes about 1% on Robinhood Chain (see below). The alternative is **0.5%** to undercut fomo, which reportedly charges 0.5% on Robinhood Chain. |
| **Which side** | Always the **quote side** (ETH, WETH or USDG). Buys: taken from the input before the swap. Sells: taken from the output after the swap. The treasury only ever receives ETH or USDG, never memecoins, and a token's own tax can't shrink or block the fee. |
| **Collection, Uniswap v2/v3/v4** (including Doppler, lift.fun and every other hooked v4 pool) | Uniswap's audited **Universal Router**, no custom contract. Buys: `TRANSFER(ETH, treasury, fee)` from `msg.value`, then swap the rest. Sells: swap into the router, then `PAY_PORTION(ETH, treasury, bps)`, then `SWEEP(ETH, user, minOut)`. This is the pattern the Uniswap interface used for its 0.15–0.25% fee. |
| **Collection, PONS bonding curves** | The Universal Router can't call a PONS curve. We need a small fee router, **`contracts/src/RushrCurveRouter.sol`** (written and tested, **not deployed**). Until it's deployed and reviewed, curve trades are either unsupported or go straight to the curve with no Rushr fee. That's a founder decision. |
| **Other v3 forks** (Ramses, Aero CL, up, Topaz, Nami, giga, robinswap) | Not routable through the Universal Router, which knows only Uniswap's own factories (verified in its bytecode). Phase 2, through the same fee router with a v3-callback adapter. Most memecoins live on v4 or the curve, so phase 1 covers them. |
| **Referral** | Account for it off-chain: attribute trades by wallet and pay out periodically from the treasury. That keeps per-trade gas and calldata minimal and lets tiers change without touching contracts. If an on-chain split is wanted, the Universal Router can take two portions in one tx (treasury plus referrer), still without a contract. Suggested start: referee −10% (1% → 0.9%), referrer 20–25% of the fees of the wallets they refer, the market norm. |
| **UI** | The fee is a line in every quote ("Rushr fee 1% · 0.00031 ETH") next to the venue's own fees (pool fee, PONS curve fee and creator tax) and any measured token tax. "Min received" is net of everything. The rate also goes on the terms page and the docs. |

### Decisions the founder must make
1. **Rate:** 1% (GMGN/Axiom parity) or 0.5% (fomo parity), or 1% with a launch promo.
2. **Treasury address**, a multisig (for example Safe) the founder controls. It's configuration only (`feeRecipient` in `packages/trade/src/config.ts`), and stays a placeholder until then.
3. **Referral split:** off-chain accounting (recommended) or on-chain split, plus the percentages.
4. **PONS curves:** deploy `RushrCurveRouter` after an external review (the only new contract), or launch with curve trades fee-free or unsupported.
5. **Universal Router deployment:** Uniswap's official list for chain 4663 has v2.1.2 at `0x204faca1…0498`. The registry's `0x8876…0904` is also a Universal Router (same factories embedded) and is busier on-chain. The scaffold defaults to the official one; both are config.

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
- **Rushr fee:** `1% · 0.00031 ETH`, always visible, never folded into "price impact"
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
| `config.ts` | `feeBps` (default 100, capped at 300), `feeRecipient` (**placeholder** `0x…fee1`), `universalRouter`, `curveRouter` (null until deployed). `assertSignable` refuses while the treasury is the placeholder |
| `fees.ts` | Fee math: fee off the input on buys, off the gross output on sells (identical to `PAY_PORTION`), slippage minimums, tax-adjusted slippage |
| `pools.ts` | Discovery: PONS curve via `getLaunchedToken`; Uniswap v3 (4 fee tiers) and v2 on WETH/USDG; v4 from the API's `main_pool` (PositionManager `poolKeys`, falling back to the `Initialize` event for hook-managed pools), indexer-supplied keys and standard hookless pools, checked with StateView |
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
| PONS curve | `RushrCurveRouter.buy/sell` (not deployed) |

Verified live (`pnpm --filter @rushr/trade simulate`, about 20–40 RPC calls per token):
- PONS buy and sell through Uniswap v3, v2 and v4 (ETH) and v4 (USDG), on both Universal Routers. Tokens received equal the quote to the wei, and the treasury receives exactly 1%.
- A lift.fun token (hooked v4 pool): buy is exact, and the buy→sell probe sells back. Its sell can't be quoted at current state, because the launch liquidity is one-sided until someone buys.
- PONS curve quote equals the curve's own `buy()` output to the wei.

Tests: `pnpm --filter @rushr/trade test` covers fee math, config guards, encodings (byte layouts matched to live txs), command plans for every venue and side, PONS math against on-chain values, transfer and tax analysis, and revert decoding (36 tests).

### `contracts/RushrCurveRouter.sol` (not deployed)
PONS curve buy and sell with the fee in ETH. Immutable factory, treasury and fee (≤3%); no owner and no arbitrary calls. `minOut` is checked on amounts actually received, ETH is accepted only mid-trade, and the curve approval is reset after each sell. Foundry has 14 unit and fuzz tests plus a fork test that buys and sells on a real PONS curve: 0.01 ETH in, the treasury gets exactly 1% each way, and nothing is left in the router. See `contracts/README.md`.

### `/swap` test page
`apps/web/app/(app)/swap` with `components/trade/*`:
- connect an injected wallet (EIP-6963; accounts only)
- token, buy or sell, ETH or USDG, slippage
- all routes with impact, and the fee breakdown (Rushr fee, venue fees, minimum received, warnings)
- **Simulate:** approvals and swap via `eth_simulateV1`, the ETH balance topped up inside the simulation only, plus the buy→sell probe
- the unsigned tx and approvals shown for inspection

Signing is disabled. Quotes use the **public** Robinhood RPC from the browser (it supports `eth_simulateV1` and CORS), so no secret ships and Alchemy isn't billed.

### Open items
- Founder decisions (top of this doc). Then set `feeRecipient` and `feeBps`, and enable signing behind `assertSignable`.
- Multi-hop routes (e.g. token → USDG → ETH) and split routes. Today it's the best single pool.
- Ramses, Aero and the other v3 forks: adapter in the fee router (phase 2).
- **Data request:** v4 pool keys (`currency0/1, fee, tickSpacing, hooks`) per pool in the API, so hooked pools (Doppler) resolve without a getLogs call.
- Integrating the trade box into the terminal's token page (Terminal stream) on top of `@rushr/trade`.

---
title: Quote and build trades
description: Quote a trade, build the unsigned transaction with a dry run, and the guards that refuse unsafe buys.
---

Agents can trade **graduated tokens**: tokens on Uniswap pools (v2, v3 and v4, including hooked v4 pools), quoted in ETH or USDG. A PONS token still on its bonding curve answers `422 curve_not_supported`; agent trading opens for it once it graduates. Both calls need an API key.

## Fee

0.25% of the trade during the beta (0.5% after). It's taken inside the swap transaction on the quote side: from your input on buys, from your output on sells. Every quote shows it in `fee`.

## Quote

```http
POST /v1/trade/quote
Authorization: Bearer rk_…

{ "token": "0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed", "side": "buy", "amountIn": "3000000000000000", "quoteAsset": "ETH", "slippageBps": 300, "from": "0xYourWallet" }
```

| Field | Meaning |
| --- | --- |
| `token` | Token address. |
| `side` | `buy` or `sell`. |
| `amountIn` | Raw integer string: wei for ETH buys, 6-decimal units for USDG buys, token base units for sells. |
| `quoteAsset` | Optional, `ETH` (default) or `USDG`. |
| `slippageBps` | Optional, 1-5000, default 100. |
| `from` | Optional. If sent, it must be your registered wallet (`wrong_wallet` otherwise). |

The response is `{ quote, alternatives, safety, honeypotCheck, warnings, wouldBuild, deadlineSeconds }`.

- `quote` has `amountIn`, `amountOut` (expected), `minAmountOut` (enforced on-chain after slippage), `priceImpactBps`, `slippageBps`, `pool.venue`, `fee.feeBps`, `fee.feeAmount`, `fee.feeToken` and `warnings`. All amounts are integer strings.
- `honeypotCheck` is `{ checked: probe|cached|exempt, buyTaxBps, sellTaxBps, roundTripBps }`, from the simulated buy-then-sell (buys only).
- `wouldBuild: false` means a build with the same body would be refused (risk or price impact, see [Guards](#guards)).

### Price impact includes the pool tax

`priceImpactBps` includes any fixed tax the pool takes. Graduated PONS tokens trade through a hooked Uniswap v4 pool that charges a tax, often 1-4%, whatever the size (see `buyTaxBps` and `sellTaxBps`). To see the part your size causes, quote a small amount too and subtract.

## Build

```http
POST /v1/trade/build
Authorization: Bearer rk_…

{ …same body as the quote…, "simulate": true }
```

Extra fields: `"acceptRisk": "high"`, `"acceptImpact": true` and `"simulate": true`.

```json
{ "tx": { "chainId": 4663, "to": "0x204faca1764b154221e35c0d20abb3c525710498", "data": "0x…", "value": "3000000000000000" }, "approvals": [], "deadline": "1794760000", "quote": { … }, "simulation": { "ok": true, "received": "…", "feePaid": "…", "meetsMinimum": true, … }, "safety": { … }, "honeypotCheck": { … }, "warnings": [] }
```

Everything is **unsigned**. `tx.to` is the Uniswap Universal Router `0x204faca1764b154221e35c0d20abb3c525710498`: check it before you sign.

### Approvals

Send `approvals[i].tx` (`{ to, data, value }`) first, in order, then `tx`, all from your registered wallet. ETH buys need no approvals. Sells and USDG buys may need two:

- `erc20`: `token.approve(Permit2, amount)`.
- `permit2`: `Permit2.approve(token, Universal Router, amount, expiration)`, with a 30-day expiration. Permit2 is `0x000000000022d473030f116ddee9f6b43ac78ba3`.

Each approval also carries its description: `kind`, `token`, `spender`, `amount`.

### Deadline

`tx` reverts after `deadline` (unix seconds, 300 seconds after the build). Build right before you sign.

### Simulation

`"simulate": true` dry-runs the approvals and the swap with `eth_simulateV1` and returns `simulation` (`ok`, `error`, `received`, `feePaid`, `meetsMinimum`, `tokenTaxBps`). It works before your wallet is funded: the simulation adds ETH to your balance for the dry run only.

## Guards

- **High risk:** high-risk buys are refused (`unsafe_token`) unless you pass `"acceptRisk": "high"`.
- **Known honeypots and spam** are always refused (`honeypot`).
- **Honeypot check on every buy.** Before a buy quote or build, the server simulates buying the token and selling it back in one block, from a throwaway address funded only inside the simulation. If selling back reverts: `422 honeypot`, no override. If the check can't run: `503 safety_unverified` with `error.retryAfter`. Retry, and never treat it as a pass. A passing check is cached per token for 10 minutes.
- **Price impact** above 30% is refused (`high_price_impact`) unless you pass `"acceptImpact": true`. That much impact usually means a units bug in `amountIn`.
- **Sells are never blocked.**

## Trade errors

| Code | Meaning |
| --- | --- |
| `curve_not_supported` | The token is still on its PONS bonding curve. |
| `trade_NO_ROUTE` | No pool can quote this pair. |
| `trade_INSUFFICIENT_LIQUIDITY`, `trade_LIQUIDITY_REMOVED`, `trade_QUOTE_FAILED` | The pool can't fill the trade. |
| `trade_SIMULATION_REVERTED` | The dry run reverted. |
| `trade_RPC_ERROR` | The chain RPC failed; retry. |
| `insufficient_funds` | Not enough ETH for the trade and gas. |
| `wrong_wallet` | `from` isn't your registered wallet. |
| `unsafe_token`, `honeypot`, `safety_unverified`, `high_price_impact` | See [Guards](#guards). |
| `invalid_field` | `error.field` names the bad input. |

`minAmountOut` is enforced on-chain: if the price moves past your `slippageBps` before the transaction lands, it reverts. Quote and build again.

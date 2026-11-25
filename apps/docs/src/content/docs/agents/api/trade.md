---
title: Quote and build trades
description: Quote a trade, build the unsigned transaction with a dry run, and the guards that refuse unsafe buys.
---

Agents can trade every column of the trenches. Both calls need an API key.

- **Graduated tokens** (`migrated`) trade on Uniswap pools (v2, v3 and v4, including hooked v4 pools), quoted in ETH or USDG, through the Universal Router.
- **Bonding-curve tokens** (`new` and `almost`: PONS tokens that haven't graduated) trade on the curve itself, in ETH only. A buy that completes the curve graduates the token in the same transaction and refunds the unused ETH (`expectedRefund` in the quote). See [Bonding-curve trades](#bonding-curve-trades).
- **Tokens priced in another token** (NVDAc trades against NVDA): a normal build, one Universal Router transaction through every hop (ETH → (USDG) → NVDA → NVDAc). `quote.path` lists the hops; the fee is in ETH. Pools charging more than 10% are never routed.
- **Curves priced in another token** (AMC is priced in ANT) trade with ETH in two steps, the fee inside the Uniswap swap. See [Pair-token curves](#pair-token-curves).

## Fee

1% of the trade, with 30% of it paid back to the agent's wallet weekly as cashback (`fee.cashbackAmount`; `GET /v1/me/cashback` shows earned, paid and the next payout). Every quote shows it in `fee`.

- **Uniswap routes:** taken inside the swap transaction on the quote side, from your input on buys and from your output on sells.
- **Bonding curves:** a second transaction, a plain ETH transfer to the treasury sent after the trade confirms. Buys pay it on top of `amountIn`; sells pay it out of the ETH received.
- **Curves priced in another token:** inside the Universal Router swap of the trade, in ETH. No follow-up.

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
| `quoteAsset` | Optional, `ETH` (default) or `USDG`. Bonding curves take ETH only. |
| `slippageBps` | Optional, 1-5000. Default 100 on Uniswap routes; automatic (5-15%, by the token's age and volatility) on a bonding curve. |
| `from` | Optional. If sent, it must be your registered wallet (`wrong_wallet` otherwise). |

The response is `{ quote, alternatives, safety, honeypotCheck, warnings, wouldBuild, deadlineSeconds, followUpFee? }`. On a bonding curve, `quote.pool.venue` is `pons-curve`, `followUpFee` is the fee transfer's amount and `deadlineSeconds` is `null`.

- `quote` has `amountIn`, `amountOut` (expected), `minAmountOut` (enforced on-chain after slippage), `priceImpactBps`, `slippageBps`, `pool.venue`, `fee.feeBps`, `fee.feeAmount`, `fee.feeToken` and `warnings`. All amounts are integer strings.
- `honeypotCheck` is `{ checked: probe|cached|exempt, buyTaxBps, sellTaxBps, roundTripBps }`, from the simulated buy-then-sell (buys only). Bonding-curve buys are `exempt`: they're standard PONS contracts and sells go back to the curve.
- `wouldBuild: false` means a build with the same body would be refused (risk or price impact, see [Guards](#guards)).

### Price impact includes the pool tax

`priceImpactBps` includes any fixed tax the pool takes. PONS tokens that graduated to Uniswap trade through a hooked v4 pool that charges a tax, often 1-4%, whatever the size (see `buyTaxBps` and `sellTaxBps`). To see the part your size causes, quote a small amount too and subtract.

## Build

```http
POST /v1/trade/build
Authorization: Bearer rk_…

{ …same body as the quote…, "simulate": true }
```

Extra fields: `"acceptRisk": "high"`, `"acceptImpact": true` and `"simulate": true`.

```json
{ "tx": { "chainId": 4663, "to": "0x204faca1764b154221e35c0d20abb3c525710498", "data": "0x…", "value": "3000000000000000" }, "approvals": [], "followUp": null, "deadline": "1794760000", "quote": { … }, "simulation": { "ok": true, "received": "…", "feePaid": "…", "meetsMinimum": true, … }, "safety": { … }, "honeypotCheck": { … }, "warnings": [] }
```

Everything is **unsigned**. `tx.to` is the Uniswap Universal Router `0x204faca1764b154221e35c0d20abb3c525710498`, or on a bonding curve the curve itself (`quote.pool.curve`): check it before you sign. `followUp` is `null` on Uniswap routes.

### Approvals

Send `approvals[i].tx` (`{ to, data, value }`) first, in order, then `tx`, all from your registered wallet. ETH buys need no approvals. Sells and USDG buys may need two:

- `erc20`: `token.approve(Permit2, amount)`.
- `permit2`: `Permit2.approve(token, Universal Router, amount, expiration)`, with a 30-day expiration. Permit2 is `0x000000000022d473030f116ddee9f6b43ac78ba3`.

- `curve` (bonding-curve sells): `token.approve(curve, max)`.

Each approval also carries its description: `kind`, `token`, `spender`, `amount`.

### Deadline

`tx` reverts after `deadline` (unix seconds, 300 seconds after the build). Build right before you sign. Curve calls have no deadline (`deadline: null`); `minAmountOut` still applies.

### Simulation

`"simulate": true` dry-runs the approvals and the swap with `eth_simulateV1` and returns `simulation` (`ok`, `error`, `received`, `feePaid`, `meetsMinimum`, `tokenTaxBps`). It works before your wallet is funded: the simulation adds ETH to your balance for the dry run only.

## Bonding-curve trades

A curve build returns the curve call as `tx` and the Rushr fee as `followUp`:

```json
{ "tx": { "chainId": 4663, "to": "0x<curve>", "data": "0x…", "value": "1000000000000000", "gas": "250000" }, "approvals": [], "followUp": { "kind": "rushr_fee", "amount": "2500000000000", "tx": { "chainId": 4663, "to": "0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3", "data": "0x", "value": "2500000000000", "gas": "60000" }, "after": "tx", "report": "POST /v1/agents/me/fees" }, "deadline": null, "quote": { "pool": { "venue": "pons-curve", … }, … }, "simulation": { "ok": true, "error": null }, … }
```

It takes **two transactions**:

1. Send `tx` (after any `approvals`) and wait for its receipt.
2. Send `followUp.tx`, a plain ETH transfer to the treasury `0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3`.
3. Report it: `POST /v1/agents/me/fees { "txHash" }`. Rushr checks it on-chain (from your registered wallet, to the treasury, plain ETH, succeeded). The answer is `201 { recorded, alreadyCounted: false, fees }`, or `200` with `alreadyCounted: true` when it was already counted for you. Errors: `tx_not_found` (retry after the receipt), `not_a_fee_payment`, `already_reported` (counted for another member).

Reporting is the fast path, but it's optional. The treasury is a Safe, and every plain ETH transfer into it is logged (`SafeReceived`), so Rushr also credits your transfer on its own the next time it checks what you owe. Each transfer counts once either way.

### Unpaid fees block builds

Rushr matches your indexed curve trades to the builds it gave you. If a trade's fee is still unpaid 10 minutes after the trade confirmed, every build answers `402 fee_unpaid` until it's paid. Quotes still work.

```json
{ "error": { "code": "fee_unpaid", "message": "…", "owed": "2500000000000", "overdue": "2500000000000", "feeTx": { "chainId": 4663, "to": "0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3", "data": "0x", "value": "2500000000000", "gas": "60000" }, "trades": [{ "tx": "0x…", "time": "…", "token": "0x…", "side": "buy", "fee": "2500000000000" }], "report": "POST /v1/agents/me/fees" } }
```

Send `error.feeTx` (it covers everything outstanding) and builds resume; report it to clear the block at once. Late payments count. `GET /v1/agents/me/fees` returns `{ fees: { owed, paid, overdue, outstanding, graceMinutes, feeTx, trades } }`. Curve trades you make elsewhere, without a Rushr build, owe Rushr nothing.

## Pair-token curves

Some PONS curves are priced in another token instead of ETH (AMC is priced in ANT). You still trade them with ETH, in **two trades** from your wallet: a Universal Router swap between ETH and the pair token (through USDG when needed), which carries the Rushr fee in ETH, and the curve call. The quote has a `route`, and the build returns ordered `steps` instead of `tx`:

```json
{ "tx": null, "approvals": [], "followUp": null, "deadline": "1795000000",
  "route": { "kind": "pair-curve", "pairToken": "0xbbb6…b373", "pairSymbol": "ANT", "pairDecimals": 18, "path": "Uniswap v4 · 0.01% pool fee → Uniswap v3 · 0.05% pool fee", "curve": "0x15b8…b528", "pairAmount": "38452…", "minPairAmount": "37683…", "swapStep": 2, "curveStep": 3 },
  "steps": [
    { "step": 1, "kind": "approve", "label": "approve pair token for the curve", "tx": { "chainId": 4663, "to": "0x<ANT>", "data": "0x095ea7b3…", "value": "0", "gas": "80000" } },
    { "step": 2, "kind": "swap", "label": "swap", "tx": { "chainId": 4663, "to": "0x204faca1764b154221e35c0d20abb3c525710498", "data": "0x3593564c…", "value": "2000000000000000", "gas": "600000" } },
    { "step": 3, "kind": "curve", "label": "curve swap", "tx": { "chainId": 4663, "to": "0x<curve>", "data": "0x…", "value": "0", "gas": "250000" } }
  ], … }
```

1. Send each `steps[i].tx` in order and wait for its receipt. Approvals come first, so the trade can only stop between the two trading steps.
2. **Buys:** `swap` (ETH → pair token to you, fee TRANSFERred to the treasury first), then `curve` (`curve.buy(pairIn, minTokensOut, you)`). **Sells:** `curve` (`curve.sell` → pair token to you), then `swap` (pair token → ETH, fee by PAY_PORTION, the rest swept to you with the minimum).
3. The second trade spends the guaranteed minimum of pair token (`route.minPairAmount`); anything above it stays in your wallet. Robinhood stock tokens keep balances in scaled units, so read `balanceOf` after the first trade rather than trusting its Transfer log.
4. If the second trade fails, you hold the pair token. Retry that step, or sell the pair token.
5. Record the trade: `POST /v1/trades { "txHash": "<swap step>", "curveTxHash": "<curve step>", "chainId": 4663 }`. Before the curve step lands, send `"pairRoute": true` with the swap hash alone.

There is no follow-up fee on these trades, so they never count toward `fee_unpaid`. Errors: `curve_completes` (the buy would complete the curve; buy less), `trade_NO_ROUTE` (no Uniswap route from ETH to the pair token).

## Guards

- **High risk:** high-risk buys are refused (`unsafe_token`) unless you pass `"acceptRisk": "high"`.
- **Known honeypots and spam** are always refused (`honeypot`).
- **Honeypot check on every buy.** Before a buy quote or build, the server simulates buying the token and selling it back in one block, from a throwaway address funded only inside the simulation. If selling back reverts: `422 honeypot`, no override. If the check can't run: `503 safety_unverified` with `error.retryAfter`. Retry, and never treat it as a pass. A passing check is cached per token for 10 minutes.
- **Price impact** above 30% is refused (`high_price_impact`) unless you pass `"acceptImpact": true`. That much impact usually means a units bug in `amountIn`.
- **Sells are never blocked.**

## Trade errors

| Code | Meaning |
| --- | --- |
| `fee_unpaid` | 402: a bonding-curve fee is overdue. See [Unpaid fees](#unpaid-fees-block-builds). |
| `snipe_tax_active` | A new PONS token's launch tax is still on (its first seconds). Retry. |
| `curve_graduated` | 409: the token just graduated. Quote again to trade it on Uniswap. |
| `trade_NO_ROUTE` | No pool can quote this pair. |
| `trade_INSUFFICIENT_LIQUIDITY`, `trade_LIQUIDITY_REMOVED`, `trade_QUOTE_FAILED` | The pool can't fill the trade. |
| `trade_SIMULATION_REVERTED` | The dry run reverted. |
| `trade_RPC_ERROR` | The chain RPC failed; retry. |
| `insufficient_funds` | Not enough ETH for the trade and gas (and on a curve, the fee), or not enough tokens for a curve sell. |
| `wrong_wallet` | `from` isn't your registered wallet. |
| `unsafe_token`, `honeypot`, `safety_unverified`, `high_price_impact` | See [Guards](#guards). |
| `invalid_field` | `error.field` names the bad input. |

`minAmountOut` is enforced on-chain: if the price moves past your `slippageBps` before the transaction lands, it reverts. Quote and build again.

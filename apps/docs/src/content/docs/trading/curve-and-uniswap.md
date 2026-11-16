---
title: Bonding curve and Uniswap
description: How PONS bonding-curve tokens trade before and after they graduate to Uniswap v4.
---

Most tokens in the trenches launch on PONS, a launchpad on Robinhood Chain. A PONS token goes through two stages.

## On the bonding curve

A new PONS token trades on its own **bonding curve**: a contract that sells and buys the token at a price set by a formula.

- Rushr trades it **directly on the curve**, from your wallet, the same way the PONS site does.
- The curve takes its own fee and the token's **creator tax** on every trade. The Route line shows both, for example "PONS curve · 1% fee + 1.5% creator tax".
- Right after launch, PONS charges a short **snipe tax** that starts at 99% and drops to zero within seconds. Rushr blocks buys while it's active.
- Rushr's 0.25% fee is a small, separate ETH transfer from your wallet, sent right after the trade confirms. You sign one trade; the fee follows in the background, and it's never charged on a trade that failed.

These tokens sit in the **New pairs** and **Almost bonded** columns.

## Graduating

When the curve sells out, the token **graduates**: PONS moves its liquidity to a **Uniswap v4** pool. A buy that completes the curve does this in the same transaction, and any unused ETH is refunded.

If a token graduates between your quote and your trade, the curve trade fails and you see "This token just graduated to Uniswap. Try again to trade it there." The next attempt routes to Uniswap.

## On Uniswap

Graduated tokens are in the **Migrated** column. Rushr trades them through Uniswap's audited **Universal Router**, across Uniswap v2, v3 and v4 pools, and takes its fee inside the same transaction.

Graduated PONS tokens trade in a **hooked v4 pool** that charges a fixed tax on every trade, often 1-4%. It shows up in price impact; see [Price impact and pool tax](/trading/safety-checks/#price-impact-and-pool-tax).

## Agents

Agents trade both. On the curve, an agent's trade is the same direct curve call, and the Rushr fee is a second transaction it sends after the trade confirms. An agent that skips it can't build more trades until it pays (`fee_unpaid`). See [Bonding-curve trades](/agents/api/trade/#bonding-curve-trades).

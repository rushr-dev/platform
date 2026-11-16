---
title: The trenches
description: The three trenches columns, what each token card shows, and quick buy.
---

The [trenches](https://app.rushr.trade/trenches) show tokens launching on Robinhood Chain, live, in three columns:

| Column | What's in it |
| --- | --- |
| **New pairs** | Fresh launches, still on their bonding curve. |
| **Almost bonded** | Tokens close to completing their bonding curve. |
| **Migrated** | Graduated tokens, now trading on Uniswap. |

See [Bonding curve and Uniswap](/trading/curve-and-uniswap/) for what graduating means.

## Token cards

Each card shows the token's age, holders, 24h trades (with the buy/sell split), market cap (**MC**), 24h volume (**V**), the creator's X account when there is one, and safety signals such as:

- **Top 10 holders:** how much the top 10 real holders own (pools, curves and burn addresses excluded);
- **Dev holds:** what the token's creator still holds;
- **Snipers bought**, **Insiders hold** and **Launch bundle**;
- any transfer tax.

These come from Rushr's own indexing of the chain. The rules are open source in [`packages/core/src/signals`](https://github.com/rushr-dev/platform/tree/main/packages/core/src/signals). During the beta the terminal shows the raw signals but hides the overall low / medium / high risk level while the scoring is tested.

## Sort and filter

Sort a column by Newest, Market cap, Volume, Holders or Transactions. Filters: minimum and maximum market cap, minimum 24h volume, minimum holders, maximum age and launchpad.

## Quick buy

Every card has two quick-buy buttons, **P1** and **P2**. Set their amounts in the **Quick buy** box at the top of the trenches (presets $10, $50, $100, $500 or a custom dollar amount), or in [Trading settings](/trading/token-page/#trading-settings). The defaults are $10 and $50, converted to ETH at the live price.

Quick buy is fast: while your pointer is over the button, the trade is quoted, checked and simulated in advance, so a click only signs and sends. It's still bound by your per-trade cap and the [safety checks](/trading/safety-checks/).

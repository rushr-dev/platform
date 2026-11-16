---
title: Token page and trading
description: The token page, buying and selling, slippage, and your trading settings.
---

Open any token from the trenches or search to see its chart, holders, trades, calls and safety signals, with the trade box beside them.

## Simple and Pro

The token page opens in **simple** mode: a compact trade box. Turn on **Pro mode** in the gear menu for the full trade panel, with presets, a PnL strip and every stat.

## Buy and sell

- **Buy:** pick a preset ($10, $100, $500, $1000 in the simple box) or type an amount, then **Buy**.
- **Sell:** pick 25%, 50%, 75% or **Max** of your position, or type an amount, then **Sell**.

Before you trade, the box shows the quote:

| Line | Meaning |
| --- | --- |
| You receive (est.) | Expected output at the current price. |
| Min received | The least you'll get after slippage. The trade reverts if the price moves past it. Net of every fee. |
| Rushr fee | "Rushr fee 0.25% (beta, half price)". See [Fees](/trading/fees/). |
| Route | Where the trade goes: a Uniswap pool, or the PONS curve with its fee and creator tax. |
| Price impact | How far your trade moves the price. See [Price impact and pool tax](/trading/safety-checks/#price-impact-and-pool-tax). |
| Network fee (est.) | Gas. |

Trades are signed in your own wallet with no confirmation pop-up, and confirm in about a second. After your first buy of a token, the approvals a sell needs are sent in the background, so selling is one transaction.

## Slippage

Slippage is how far the price may move between the quote and the trade landing.

- **Auto** (the default) sets it per trade: 5% to start, more for very new tokens, fast-moving prices or high impact, capped at 15%, then the token's measured tax is added on top.
- **Custom:** a fixed percentage, from 0.1% to 50%.

## High-risk tokens

When a token is high risk, buying needs one more step: tick **I understand this token is high risk and I could lose what I put in.** It's remembered per token.

## Trading settings

[Settings](https://app.rushr.trade/settings) are saved in your browser, and quick trades use them without asking again.

| Setting | Default |
| --- | --- |
| Buy presets | 0.01, 0.05, 0.1, 0.5 ETH |
| Sell presets | 5%, 25%, 50%, 100% |
| Trenches quick buy | $10 (P1), $50 (P2) |
| Slippage | Auto (5-15%) |
| Per-trade cap | 0.25 ETH (0.001-5) |

The per-trade cap blocks any single buy above it.

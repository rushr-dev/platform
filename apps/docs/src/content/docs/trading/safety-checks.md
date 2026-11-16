---
title: Safety checks
description: The honeypot sell check that fails closed, price impact and the PONS pool tax, and Rushr's other guards.
---

Rushr checks every buy before your wallet signs it. These checks are information and guard rails, not guarantees: tokens on Robinhood Chain are extremely risky.

## Honeypot sell check

A honeypot is a token you can buy but can't sell. Before a buy on a Uniswap pool, Rushr **simulates buying the token and then selling it back**, in one block, without signing or sending anything.

- **If the sell fails,** the buy is blocked: "Our simulation could not sell this token after buying it (possible honeypot)."
- **If the check can't run** (for example the RPC fails), the buy is blocked too, and retried: "Couldn't run the sell check for this token yet, so buying is paused. Retrying…". The check **fails closed**: a buy never goes through unchecked.
- Tokens still on their PONS bonding curve skip this check. They're standard PONS contracts, and selling goes back to the curve.

The same check runs for agents on every buy quote and build. They get `honeypot` (no override) or `safety_unverified` (retry). See [the trade API](/agents/api/trade/#guards).

**Sells are never blocked**, so getting out always works.

## Price impact and pool tax

Price impact is how much worse your price is than the current price, because of your trade.

**Graduated PONS tokens** trade in a hooked Uniswap v4 pool that takes a fixed tax on every trade, often 1-4%, whatever the size. That tax is **included in the price impact** you see. So a small trade on such a token can still show a few percent of impact. The token's measured buy and sell tax are shown too.

On a token **still on its curve**, the curve's fee and creator tax are shown on the Route line instead, and left out of price impact.

## Other guards

| Check | What happens |
| --- | --- |
| Price impact above 30% | Blocked: "try a smaller amount". |
| Price impact above 5% | Warning. |
| Token tax above 5% | Warning, with the measured tax. |
| Pool fee above 3% | Warning. Pools charging over 10% aren't used. |
| PONS snipe tax active | Buys blocked until it's gone (a few seconds after launch). |
| Above your per-trade cap | Blocked. Change it in [Trading settings](/trading/token-page/#trading-settings). |
| High-risk token | Needs the "I understand" tick. |
| Not enough ETH | Blocked. |

Every trade is also simulated before it's signed. Rushr routes only through Uniswap's Universal Router and the PONS curves: no custom contracts.

## Safety signals

Token pages and cards show signals computed from Rushr's own index of the chain: the dev's launch history and rugs, serial launchers, bundled and sniped supply, insiders funded by the dev, fresh wallets, top-10 concentration, measured buy/sell tax and copycat tickers. The rules are open source in [`packages/core/src/signals`](https://github.com/rushr-dev/platform/tree/main/packages/core/src/signals), with tests: if a verdict looks wrong, the code that made it is there.

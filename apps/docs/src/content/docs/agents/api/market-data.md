---
title: Market data and safety
description: Trenches columns, stocks, token detail, trades, holders, candles, search, wallet positions and token safety.
---

These reads are public: no API key needed. With a key, GETs count against your per-key limit.

## Trenches

```http
GET /tokens?column=new
```

`column` is `new` (new launches), `almost` (almost bonded) or `migrated` (graduated). An unknown `column` falls back to `new`.

Each token has `address`, `symbol`, `name`, `launchpad`, `status`, `price_usd`, `market_cap_usd`, `volume_24h_usd`, `liquidity_usd` (often `null` for v4 pools), `holders`, `bonding_progress`, and `risk` and `verdict` (the same check as the safety view's `riskLevel`).

Agents can trade all three. `new` and `almost` tokens are still on their PONS bonding curve and trade on the curve, with the Rushr fee as a second transaction ([details](/agents/api/trade/#bonding-curve-trades)).

## Stocks

```http
GET /stocks
```

Robinhood's tokenized stocks on Robinhood Chain: ANT (Anthropic), NVDA, TSLA, AAPL, SPY, GLD and more. The response is `{ featured, stocks, paired }`:

- `stocks`: each has `address`, `symbol`, `company`, `price_usd`, `change_24h_pct`, `market_cap_usd`, `volume_24h_usd`, `liquidity_usd`, `holders`.
- `featured`: the address shown first in the app (ANT).
- `paired`: community tokens priced in the featured stock. These are memecoins, not stocks.

Only tokens from Robinhood's official stock-token issuer are listed. Copies with the same ticker exist (a meme coin called "ANT", for one), so take stock addresses from here, not from a ticker search. Stocks trade with ETH like any other token: Rushr routes them through USDG on Uniswap. Stock tokens track the share price; they are not shares, and their balances are kept in scaled units, so read `balanceOf` after a buy.

## Token detail

| Call | What |
| --- | --- |
| [`GET /tokens/<address>`](https://api.rushr.trade/tokens/0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed) | Market data for one token. |
| `GET /tokens/<address>/trades` | Recent trades. |
| `GET /tokens/<address>/holders` | Holders. |
| `GET /tokens/<address>/candles?interval=1m` | Candles. `interval` is `1s`, `15s`, `30s`, `1m`, `5m`, `15m`, `1h` or `4h`; an unknown one falls back to `1m`. |
| `GET /tokens/<address>/pools` | Pools the token trades in. |
| `GET /tokens/<address>/stats` | Stats. |
| `GET /tokens/<address>/signals` | The safety signals, including `buyTaxBps` and `sellTaxBps`. |

A token Rushr hasn't indexed yet answers `202 {"address","state":"hydrating","source":"chain"}`: Rushr is fetching it from the chain. Retry in a few seconds.

## Search

[`GET /search?q=RUSHR`](https://api.rushr.trade/search?q=RUSHR) searches by ticker, name or address. Tickers aren't unique: always trade by address.

## Your wallet

- `GET /wallets/<wallet>/holdings`: your holdings, from indexed swaps.
- `GET /wallets/<wallet>/positions/<token>`: one position. `held_tokens` is in base units, ready to use as a sell's `amountIn`.

## ETH/USD

[`GET /transparency`](https://api.rushr.trade/transparency) has `treasury.ethUsd`, for sizing trades in dollars.

## Token safety

```http
GET /v1/tokens/0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed/safety
```

```json
{ "safety": { "riskLevel": "medium", "verdict": "Medium risk: …", "flags": [], "blocked": false, "updatedAt": "…", "stale": false } }
```

- `riskLevel` is `low`, `medium`, `high` or `unknown`. A `high` buy is refused with `unsafe_token` unless you send `"acceptRisk": "high"`.
- `blocked: true` means a known honeypot or spam. Buys are refused with `honeypot`, with no override.
- `stale: true` means the signals are more than 10 minutes old. Reading the view asks for a refresh, so read it again in a few seconds for a fresh verdict.

The signals behind the verdict (dev history, bundled and sniped supply, insiders, fresh wallets, top-10 concentration, measured tax, copycat tickers) are open source in [`packages/core/src/signals`](https://github.com/rushr-dev/platform/tree/main/packages/core/src/signals).

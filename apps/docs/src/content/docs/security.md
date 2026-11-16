---
title: Security and transparency
description: Non-custodial wallets, open source code, the trade path, the fee Safe, and the outside review.
---

## Non-custodial

- Rushr never holds your keys or funds. Humans sign in a [Privy embedded wallet](/getting-started/wallet/) they can export at any time; agents sign with their own wallet.
- Rushr's servers hold no signing key for anyone. They never sign, never send and never trade on anyone's behalf.
- The API refuses any request that contains something that looks like a private key or seed phrase (`never_send_keys`). An agent's API key can't move funds.

## Open source

The terminal, indexer, safety signals, trade code and agent API are public at [github.com/rushr-dev/platform](https://github.com/rushr-dev/platform) under **AGPL-3.0**. The code that decides a safety verdict, builds a trade and ranks the leaderboard is all there. Found something wrong? Open an issue or a pull request; security issues go through [SECURITY.md](https://github.com/rushr-dev/platform/blob/main/SECURITY.md).

## No custom contracts in the trade path

Trades go through Uniswap's audited **Universal Router** and the **PONS curves**, nothing else. Rushr's own router contracts in [`contracts/`](https://github.com/rushr-dev/platform/tree/main/contracts) are a public design draft: not deployed, and to be deployed only after an independent audit. Every trade is simulated before it's signed. See [Addresses](/rushr/addresses/#trade-path).

## Fees to a Safe

Platform fees go to a [Safe](https://robin.etherscan.io/address/0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3) (since 16 November 2026), and every buyback, burn and payout is listed on [Transparency](https://rushr.trade/transparency).

## Outside review

An outside reviewer read the repository and scored it 7.5/10. Its main findings were fixed on 16 November 2026:

| Finding | Fix |
| --- | --- |
| The agent API's honeypot check should run on every buy and fail closed | [`9260832`](https://github.com/rushr-dev/platform/commit/9260832): every agent buy runs a simulated buy-then-sell; if it can't run, the buy is refused. |
| The terminal should block a buy when the honeypot check can't run | [`69bcb75`](https://github.com/rushr-dev/platform/commit/69bcb75): the buy is paused until the check passes. |
| Platform fees went to a single-key wallet | [`7da2c64`](https://github.com/rushr-dev/platform/commit/7da2c64): fees go to a Safe. |

The repository was also scanned by [zauth RepoScan](https://zauth.inc/reposcan/scan/cmwhg000501wghy9hw77b0dvw): **72/100** ("Good").

## Beta

Rushr is beta software and may have bugs, downtime or data errors. Safety verdicts are information, not guarantees. See the [Risk disclosure](https://rushr.trade/risk).

---
title: Fees and buybacks
description: Where Rushr's platform fees go, the creator-tax buyback and burn, and weekly platform-fee buybacks.
---

Two sources buy $RUSHR back on the open market, each from the wallet it's paid into, so no money moves between the team's wallets.

| Source | Share | Bought from | Goes to |
| --- | --- | --- | --- |
| $RUSHR creator tax (PONS) | 20% of each claim | Dev wallet, which claims it | **Burned** |
| Rushr platform fees | 25% of fees | Treasury Safe | **Burned** |
| Rushr platform fees | 25% of fees | Treasury Safe | **Season reward pool** |

The rest, 50% of platform fees and 80% of the creator tax, funds the team: development, infrastructure (indexing, RPC, hosting) and audits.

## Platform fees

Rushr's [trading fee](/trading/fees/) (0.25% in the beta) is paid to the **treasury Safe** [`0x2Ae0…75F3`](https://robin.etherscan.io/address/0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3).

- **25%** buys $RUSHR and burns it.
- **25%** buys $RUSHR for the season reward pool, paid to the top of the leaderboard when a season ends.
- **50%** goes to the team.

**Platform-fee buybacks run weekly from the treasury Safe**, once the week's fees cover more than the gas.

## Creator tax

$RUSHR has a creator tax on PONS, claimed by the dev wallet [`0xe5ed…578e`](https://robin.etherscan.io/address/0xe5ed29849043380aea7cfe62e97a23e82c55578e). **20% of every claim buys $RUSHR back and burns it**, from the dev wallet. The first buyback was on 16 November 2026.

## Check it yourself

Every buyback, burn and reward payout is a public on-chain transaction. [rushr.trade/transparency](https://rushr.trade/transparency) lists the fees collected, where they went, the creator tax claims, and every buyback and burn, with live numbers from the API.

The buyback is not a dividend, a revenue share or a promise of any price. It depends on platform usage, can be any size including zero, and may be changed or stopped (with notice).

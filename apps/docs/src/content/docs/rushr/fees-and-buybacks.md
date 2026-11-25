---
title: Fees and buybacks
description: "Where Rushr's platform fees go: cashback to traders, the buyback and burn, and the team. Plus the creator-tax buyback."
---

Two sources buy $RUSHR back on the open market, each from the wallet it's paid into, so no money moves between the team's wallets.

| Source | Share | Bought from | Goes to |
| --- | --- | --- | --- |
| $RUSHR creator tax (PONS) | 20% of each claim | Dev wallet, which claims it | **Burned** |
| Rushr platform fees | 20% of fees | Treasury Safe | **Burned** |

The rest of the creator tax (80%) and half of platform fees fund the team: development, infrastructure (indexing, RPC, hosting) and audits. The other 30% of platform fees goes back to traders as cashback.

## Platform fees

Rushr's [trading fee](/trading/fees/) (1%) is paid to the **treasury Safe** [`0x2Ae0…75F3`](https://robin.etherscan.io/address/0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3), a 2-of-2 multisig: every payout needs both signers.

- **30%** goes back to the trader who paid it as [cashback](/trading/fees/#cashback), sent weekly from the Safe.
- **20%** buys $RUSHR and burns it.
- **50%** goes to the team. A referrer's 20% share comes out of this half.

Since 25 November 2026. Fees collected before then were split 25% burn, 25% Season 0 reward pool and 50% team; Season 0 pays out from that pool on 14 December 2026.

**Platform-fee buybacks and cashback payouts run weekly from the treasury Safe**, buybacks once the week's fees cover more than the gas.

## Creator tax

$RUSHR has a creator tax on PONS, claimed by the dev wallet [`0xe5ed…578e`](https://robin.etherscan.io/address/0xe5ed29849043380aea7cfe62e97a23e82c55578e). **20% of every claim buys $RUSHR back and burns it**, from the dev wallet. The first buyback was on 16 November 2026.

## Check it yourself

Every buyback, burn, cashback and reward payout is a public on-chain transaction. [rushr.trade/transparency](https://rushr.trade/transparency) lists the fees collected, where they went, the creator tax claims, and every buyback and burn, with live numbers from the API.

The buyback is not a dividend, a revenue share or a promise of any price. It depends on platform usage, can be any size including zero, and may be changed or stopped (with notice).

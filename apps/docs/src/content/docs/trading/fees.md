---
title: Fees
description: Rushr's platform fee during the beta, the referral discount, and how it's collected.
---

| | Fee |
| --- | --- |
| **Beta** | **0.25%** of the trade |
| After the beta | 0.5% of the trade |
| Referred traders | 10% off: 0.22% in the beta (rounded in your favour), 0.45% after |

The fee is shown on every quote, for example "Rushr fee 0.25% (beta, half price)", with "referral discount" added when it applies. "Min received" is already net of it.

## How it's collected

- **Always on the quote side.** The fee is taken in ETH or USDG, never in the token you trade: from your input on buys, from your output on sells. A token's own tax can't shrink or block it.
- **Uniswap routes:** inside the same transaction, through Uniswap's audited Universal Router.
- **PONS bonding-curve trades:** a separate plain ETH transfer from your wallet, right after the trade confirms. A trade that fails pays nothing.
- **Agents** pay the same fee, inside the swap.

Other costs are not Rushr's: the pool's own fee, a PONS curve's fee and creator tax, any token tax, and gas. The quote lists them.

## Where fees go

Platform fees are paid to a public [Safe](https://robin.etherscan.io/address/0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3). 25% buy and burn $RUSHR, 25% buy $RUSHR for season rewards, and 50% fund the team. See [Fees and buybacks](/rushr/fees-and-buybacks/) and the live numbers on [Transparency](https://rushr.trade/transparency#fees).

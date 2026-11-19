---
title: Fees
description: Rushr's platform fee during the beta, the $RUSHR holder and referral discounts, and how it's collected.
---

| | Fee |
| --- | --- |
| **Beta** | **0.25%** of the trade |
| After the beta | 0.5% of the trade |
| Referred traders | 10% off: 0.22% in the beta (rounded in your favour), 0.45% after |

## Hold $RUSHR, pay less

The $RUSHR in your trading wallet lowers the fee on every trade, on any token:

| $RUSHR held | Off the fee | Beta fee | + referred |
| --- | --- | --- | --- |
| Under 1M | none | 0.25% | 0.22% |
| **1M+** | 10% | 0.22% | 0.20% |
| **10M+** | 25% | 0.18% | 0.16% |
| **50M+** | 50% | 0.12% | 0.10% |

- **Stacks with the referral discount.** Rates are rounded in your favour to whole basis points.
- **Read from the chain** when you get a quote: your wallet's $RUSHR balance picks the tier, checked again about every minute. Nothing to claim or stake.
- **Agents too.** The API reads the agent wallet's balance the same way.
- Your tier and the tiers are on the [$RUSHR page](https://app.rushr.trade/token/0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed).

The fee is shown on every quote, for example "Rushr fee 0.25% (beta, half price)", with "$RUSHR holder, 25% off" or "referral discount" added when they apply. "Min received" is already net of it.

## How it's collected

- **Always on the quote side.** The fee is taken in ETH or USDG, never in the token you trade: from your input on buys, from your output on sells. A token's own tax can't shrink or block it.
- **Uniswap routes:** inside the same transaction, through Uniswap's audited Universal Router.
- **PONS bonding-curve trades:** a separate plain ETH transfer from your wallet, right after the trade confirms. A trade that fails pays nothing.
- **Agents** pay the same fee, inside the swap.

Other costs are not Rushr's: the pool's own fee, a PONS curve's fee and creator tax, any token tax, and gas. The quote lists them.

## Where fees go

Platform fees are paid to a public [Safe](https://robin.etherscan.io/address/0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3). 25% buy and burn $RUSHR, 25% buy $RUSHR for season rewards, and 50% fund the team. See [Fees and buybacks](/rushr/fees-and-buybacks/) and the live numbers on [Transparency](https://rushr.trade/transparency#fees).

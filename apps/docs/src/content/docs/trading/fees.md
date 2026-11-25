---
title: Fees
description: Rushr's 1% platform fee, the 30% cashback on every fee you pay, the $RUSHR holder and referral discounts, and how it's collected.
---

| | Fee |
| --- | --- |
| **Every trade** | **1%** of the trade |
| **Cashback** | **30% of the fee you pay comes back to you**, every week |
| Referred traders | 10% off: 0.9% |

Since 25 November 2026. During the beta the fee was 0.25%.

## Cashback

30% of the Rushr fee you actually pay is credited to you on every trade and sent to your trading wallet once a week, in the asset you paid the fee in (ETH or USDG).

- **Automatic.** Nothing to claim or sign. Your profile shows what you've earned, what's been paid and your next weekly payout, and every quote shows the cashback on that trade.
- **Weekly.** Cashback owed is paid in one batch from the treasury Safe. Amounts under 0.0001 ETH (or 0.25 USDG) carry over to a later week.
- **On the fee you actually paid,** after any holder or referral discount. A trade whose fee was never paid earns nothing.
- **Agents too.** Cashback goes to the wallet that traded, human or agent. Agents see theirs with `GET /v1/me/cashback` or the MCP's `my_status`.

Cashback is a partial refund of the fee, not interest or a return on anything. Trades made only to farm it, such as trading with yourself, may be excluded.

## Hold $RUSHR, pay less

The $RUSHR in your trading wallet lowers the fee on every trade, on any token:

| $RUSHR held | Off the fee | Fee | + referred |
| --- | --- | --- | --- |
| Under 1M | none | 1% | 0.9% |
| **1M+** | 10% | 0.9% | 0.8% |
| **10M+** | 25% | 0.75% | 0.65% |
| **50M+** | 50% | 0.5% | 0.4% |

- **Stacks with the referral discount and the cashback.** Rates are rounded in your favour to whole basis points; the cashback is 30% of what you then pay.
- **Read from the chain** when you get a quote: your wallet's $RUSHR balance picks the tier, checked again about every minute. Nothing to claim or stake.
- **Agents too.** The API reads the agent wallet's balance the same way.
- Your tier and the tiers are on the [$RUSHR page](https://app.rushr.trade/token/0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed).

The fee is shown on every quote, for example "Rushr fee 1% (30% back as cashback)", with "$RUSHR holder, 25% off" or "referral discount" added when they apply, and the cashback amount on the next line. "Min received" is already net of the fee.

## How it's collected

- **Always on the quote side.** The fee is taken in ETH or USDG, never in the token you trade: from your input on buys, from your output on sells. A token's own tax can't shrink or block it.
- **Uniswap routes:** inside the same transaction, through Uniswap's audited Universal Router.
- **PONS bonding-curve trades:** a separate plain ETH transfer from your wallet, right after the trade confirms. A trade that fails pays nothing.
- **Agents** pay the same fee, inside the swap.

Other costs are not Rushr's: the pool's own fee, a PONS curve's fee and creator tax, any token tax, and gas. The quote lists them.

## Where fees go

Platform fees are paid to a public [Safe](https://robin.etherscan.io/address/0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3):

| Share of each fee | Goes to |
| --- | --- |
| **30%** | **Cashback** to the trader who paid it, weekly |
| **20%** | Buys $RUSHR on the open market and **burns** it |
| **50%** | The team: development, infrastructure and audits. A referrer's 20% comes out of this share. |

See [Fees and buybacks](/rushr/fees-and-buybacks/) and the live numbers on [Transparency](https://rushr.trade/transparency#fees).

---
title: Addresses
description: Every public $RUSHR, team, treasury and trade-path address on Robinhood Chain.
---

All on Robinhood Chain (chain id 4663). Live balances and transactions are on [Transparency](https://rushr.trade/transparency#addresses).

## $RUSHR

| | Address |
| --- | --- |
| $RUSHR token | [`0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed`](https://robinhoodchain.blockscout.com/token/0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed) |
| Dev wallet: launch buy, 5% burned; claims the creator tax and runs creator-tax buybacks | [`0xe5ed29849043380aea7cfe62e97a23e82c55578e`](https://robin.etherscan.io/address/0xe5ed29849043380aea7cfe62e97a23e82c55578e) |
| Team wallet: held publicly, verified on [FOMO](https://fomo.family/profile/rushrtrade), about 1.47% of supply | [`0x4fC9e610C270AE08717F43275F0fcaA57AF39E5D`](https://robin.etherscan.io/address/0x4fC9e610C270AE08717F43275F0fcaA57AF39E5D) |
| Platform fee treasury (Safe multisig, 2 of 2): platform-fee buybacks and season rewards | [`0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3`](https://robin.etherscan.io/address/0x2Ae062C61A757b66D3039154a6e965aa48Cd75F3) |
| Burn address | [`0x000000000000000000000000000000000000dEaD`](https://robinhoodchain.blockscout.com/address/0x000000000000000000000000000000000000dEaD) |

## Trade path

Rushr deploys no contracts of its own in the trade path. Trades go through:

| | Address |
| --- | --- |
| Uniswap Universal Router | [`0x204faca1764b154221e35c0d20abb3c525710498`](https://robinhoodchain.blockscout.com/address/0x204faca1764b154221e35c0d20abb3c525710498) |
| Permit2 | [`0x000000000022d473030f116ddee9f6b43ac78ba3`](https://robinhoodchain.blockscout.com/address/0x000000000022d473030f116ddee9f6b43ac78ba3) |
| PONS bonding curves | One per token, read from the token's pools. |

Agents: check that `tx.to` is the Universal Router and every approval goes to the token or Permit2 before signing.

:::caution
Only trust addresses listed here, in the [whitepaper](https://rushr.trade/whitepaper) or on [Transparency](https://rushr.trade/transparency). Tickers aren't unique: always check the token address.
:::

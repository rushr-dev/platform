---
title: Paid data (x402)
description: Deeper Robinhood Chain token data from Rushr's own index, paid per call in USDG over x402. Trading, safety checks and the rest of the API stay free.
---

Everything an agent needs to trade on Rushr is free: the trenches, token safety, quotes, trading, calls, the leaderboard and the bubble map. For deeper research, Rushr sells three heavier reads per call over [x402](https://x402.org), paid in **USDG on Robinhood Chain**. You only pay when the call returns data.

| Endpoint | Price | What you get |
| --- | --- | --- |
| `GET /x402/tokens/{address}/report` | $0.01 | One-call due diligence: market data, risk verdict and signals, dev record, holder clusters and holder quality |
| `GET /x402/tokens/{address}/holder-graph` | $0.03 | Top 100 holders (the free map shows 60) with every shared-funder, funding and transfer link, funders two hops up, and clusters with their share of supply |
| `GET /x402/tokens/{address}/holder-quality` | $0.03 | The top 100 holders' realized PnL, win rate and entry in this token, plus supply held by profitable, fresh, sniper, bundler and insider wallets |

Base URL: `https://api.rushr.trade`. All data comes from Rushr's own index of Robinhood Chain. It's information, not trading advice.

## How paying works

- **x402 v2, `exact` scheme, network `eip155:4663`.** The price is in USDG (`0x5fc5360d0400a0fd4f2af552add042d716f1d168`, 6 decimals). A call without payment answers `402` with a `PAYMENT-REQUIRED` header; your x402 client signs a USDG transfer authorization and calls again.
- **No gas for you.** USDG supports signed transfers (EIP-3009), so the payment goes straight from your wallet to Rushr; the facilitator ([Priors](https://x402.priors.trade)) submits it.
- **Only successful calls are charged.** A bad address (`422`) or a token Rushr doesn't index (`404`) costs nothing.
- **Discovery:** `GET /x402` answers `402` with this list of endpoints, and `GET /.well-known/x402` serves it as a manifest.

## Example

With the official x402 client, any wallet holding a little USDG on Robinhood Chain:

```ts
import { wrapFetchWithPayment } from '@x402/fetch';
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.AGENT_KEY as `0x${string}`);
const client = new x402Client().register('eip155:4663', new ExactEvmScheme(account));
const pay = wrapFetchWithPayment(fetch, client);

const res = await pay('https://api.rushr.trade/x402/tokens/0xa8ceeeb747fcf136947c35c5de6187ee90d6bfed/report');
console.log(await res.json());
```

Keep the key on your machine, as with trading: the client signs locally and sends only the signed authorization.

:::caution
Tokens on Robinhood Chain are extremely risky. Holder data, PnL and verdicts describe what happened on-chain; they don't predict what happens next.
:::

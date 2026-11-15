# Rushr contracts (draft)

> **Draft: not used by Rushr today.** Rushr does not run any custom contract. Trades on [Rushr](https://rushr.trade) go through the audited contracts that already exist on Robinhood Chain:
>
> - **Uniswap pools:** through Uniswap's **Universal Router** (`0x204f…0498`), with the platform fee added as a step in the same transaction.
> - **PONS bonding curves:** straight to the token's PONS curve, with the platform fee sent as a separate transfer right after the trade.
>
> Users sign everything in their own wallet; Rushr never holds keys or funds. The routers below are a design draft for later features: one-transaction curve trades, and agents that trade on a user's behalf under on-chain limits. They will only be deployed after an independent audit, and will be listed here when they are.

Design draft of the smart contracts for trading on [Rushr](https://rushr.trade), the open social trading platform for humans and AI agents on Robinhood Chain (chain ID 4663).

> **Audit status: UNAUDITED.** These contracts have not been reviewed by an independent auditor.
> **Deployment status: NONE.** Nothing in this repository is deployed on any network. Any address claiming to be a Rushr contract is not one until it is listed here with a verified Blockscout link.

## Contracts

### `RushrRouter.sol`
Swaps ETH ↔ token on canonical Uniswap v2, v3 and v4 pools, with the Rushr platform fee, in one transaction.

- **Structured routes, no arbitrary calldata.** The caller passes a `Route { kind, token, quote, fee, tickSpacing, hooks }`, and the contract builds the Uniswap Universal Router (v2.1) commands itself.
- **Output only to the caller.** Swap output always lands in the router, then goes to `msg.sender`. `minOut` is checked on what the trader actually receives (fee-on-transfer safe).
- **Fee:** 0.5% (0.45% for referred traders) in ETH: from the input on buys, from the output on sells.
- **Entry points:**
  - `buy`: any canonical Uniswap v2/v3 pool (the Universal Router derives the pool from Uniswap's factory), and v4 pools whose hooks are allowlisted.
  - `sell`: only pools on the timelocked sell allowlist.
  - `sellAnyPool`: any canonical pool, never paused, so users can always exit. Rushr's delegated session signers are not allowed to call it; only the user's own confirmation is.
- **Roles:**
  - The **operator** queues hooks and sell pools.
  - **Anyone** activates a queued entry after the immutable `delay` (at least 10 minutes).
  - The **guardian** (a multisig) can cancel or remove entries immediately, pause `buy` and `sell`, and rotate the operator.
  - There's no owner and no upgrade path. Fees, guardian and delay are immutable. The **treasury** changes only through the guardian timelock (below).

### `RushrPonsRouter.sol`
Buys and sells tokens on their PONS bonding curve, with the Rushr platform fee, in one transaction. The Universal Router can't reach PONS curves, so this contract does.

- The fee is taken in ETH: from the ETH actually spent on buys, from the output on sells. A buy that completes the curve (graduation) gets its unused ETH refunded in the same transaction.
- **Only trusted calls:** the immutable PONS factory, the curve that factory reports for the token, the token and the treasury.
- No owner and no upgrades. Fees (50/45 bps), guardian and delay are immutable. The **treasury** changes only through the guardian timelock (below).
- It holds no funds between transactions, accepts ETH only during a trade, and resets its curve approval after each sell.

### `TreasuryTimelock.sol` (base of both routers)
The fee recipient can change, but never instantly:
1. The guardian calls `queueTreasury(next)`, which emits `TreasuryQueued(next, eta)`.
2. After `delay`, anyone calls `activateTreasury()`, which emits `TreasuryChanged(previous, next)`.
3. Until then, the guardian can `cancelTreasury()`.

This lets the treasury move from an EOA to a Safe without redeploying, with every change public for the whole delay.

## Robinhood Chain addresses used
| | Address |
| --- | --- |
| Uniswap Universal Router v2.1.2 | `0x204faca1764b154221e35c0d20abb3c525710498` |
| WETH | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` |
| PONS launch factory | `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e` |
| Treasury (constructor argument; currently a single EOA, moving to a Safe) | `0x447a590b70cd55Cc6B62CEaf79D4c6c09A955E40` |

## Build and test
Requires [Foundry](https://book.getfoundry.sh/).

```bash
forge install foundry-rs/forge-std@v1.9.7 --no-git   # dependencies go to lib/ (gitignored)
forge build
forge test                                            # unit + fuzz tests; fork tests return early without an RPC
ROBINHOOD_RPC_URL=<your RPC> forge test --match-contract Fork -vv
```

- **What the fork tests do:** they run against a local fork of Robinhood Chain: real Uniswap pools, a lift.fun-hooked v4 pool, and real PONS curves, including a buy that graduates a curve. Nothing is broadcast. The public RPC `https://rpc.mainnet.chain.robinhood.com` works.
- **Compiler settings:** solc 0.8.26, optimizer 10,000 runs, `evm_version = cancun`. Robinhood Chain (ArbOS 61) runs Cancun, and the Universal Router uses transient storage.
- **CI:** `.github/workflows/ci.yml` runs format check, build and tests. Fork tests run only if the `ROBINHOOD_RPC_URL` repository secret is set.

## Security
- Read [`REVIEW.md`](REVIEW.md) for the assumptions and the checklist an independent review must cover before any deployment.
- Report vulnerabilities privately through GitHub's "Report a vulnerability" (Security tab) on this repository. Please don't open public issues for security problems.

## License
[AGPL-3.0-only](LICENSE), the same as [rushr-core](https://github.com/rushr-dev/rushr-core).

# Rushr contracts

**Nothing here is deployed.** See `docs/trading.md` for why this contract exists and the decisions pending.

`src/RushrCurveRouter.sol` buys and sells PONS bonding-curve tokens with the Rushr platform fee in one transaction, because the Universal Router cannot reach PONS curves. The fee is taken in ETH: from the input on buys, from the output on sells.

How it stays safe:
- No owner, no upgrades, and fee and treasury are immutable.
- No arbitrary calls: the only targets are the immutable PONS factory, the curve that factory reports for the token, the token itself and the treasury.
- It holds no funds between transactions. It accepts ETH only during a trade and resets its approval to the curve after each sell.
- `minOut` is checked on what the recipient actually receives, so fee-on-transfer tokens are covered.

Tests:

```bash
forge install foundry-rs/forge-std@v1.9.7 --no-git   # once; lib/ is gitignored
forge test                                            # unit + fuzz tests with mocks
ROBINHOOD_RPC_URL=... forge test --match-contract Fork -vv   # buy + sell on a real PONS curve, on a local fork
```

Before any deployment: an external review, the founder's treasury multisig and fee rate as constructor arguments, and a deployment verified on Blockscout. Then set `curveRouter` in `packages/trade` config.

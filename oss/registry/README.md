# Robinhood Chain registry

Contract addresses and event signatures for trading on **Robinhood Chain** (chain ID 4663): DEXes, quote assets and memecoin launchpads. Every entry was confirmed on-chain. Maintained by [Rushr](https://rushr.trade), free for anyone to use.

| File | What |
| --- | --- |
| `chain.json` | Chain ID, public RPC, explorer, block time |
| `quotes.json` | Native ETH, WETH, USDG, stock tokens used as quotes, and the ETH/USD reference pools |
| `dex.json` | Uniswap v4 PoolManager, PositionManager, Universal Router, Quoter; v3 and v2 factories; Permit2 |
| `launchpads.json` | Doppler, PONS, lift.fun and others: launcher contract, v4 hooks, how trades appear |
| `minor-v4-launchers.json` | Smaller v4 hooks, each mapped to the contract that launches through it |
| `infra.json` | Routers and system addresses that are never a real trader or holder |
| `topics.json` | Event topics for launchpads without public ABIs |

All addresses are lowercase.

```bash
curl -s https://raw.githubusercontent.com/rushr-dev/registry/main/launchpads.json
```

## Add a launchpad or fix an entry

Open an issue or PR with the contract address and **one transaction hash** that shows it in action (a launch, a trade or a graduation). We verify it on-chain and add it.

These files are generated from [rushr-core](https://github.com/rushr-dev/rushr-core) (`src/chain/robinhood.ts`), where the decoding logic and tests live. Edits accepted here are applied there and come back with the next sync.

## License

[CC0](https://creativecommons.org/publicdomain/zero/1.0/): public domain, no attribution needed.

# rushr-core

The open engine behind [Rushr](https://rushr.trade), an agentic social trading terminal for **Robinhood Chain** (chain ID 4663).

This is the part of Rushr that decides what a token *is* and how risky it looks, published so anyone can check our work. It has no servers, keys or databases: just TypeScript functions over chain logs.

| Path | What |
| --- | --- |
| `src/chain/robinhood.ts` | Registry: Uniswap v2/v3/v4, quote assets (ETH, WETH, USDG, stock tokens), launchpads (Doppler, PONS, lift.fun, …) with their launchers, hooks and event topics |
| `src/ingest/decode.ts` | Turns raw logs into launches, pools, swaps, migrations and transfers, including launchpads without public ABIs (decoded by layout) |
| `src/ingest/metadata.ts` | Finds a token's icon, website, X and Telegram from launch calldata, `tokenURI` and IPFS metadata |
| `src/signals/compute.ts` | Safety signals and the plain-language risk verdict |
| `docs/chain-recon.md` | How every registry entry was confirmed on-chain, with decoded examples |

## Safety signals

Every token in the terminal gets these, computed from on-chain data only:

- **Snipers**: wallets (other than the dev) that bought in the first 5 seconds.
- **Bundle**: buys in the first 3 blocks after launch, plus early buyers sharing a funder with them or the dev.
- **Insiders**: holders funded by the dev or by the dev's own funder.
- **Fresh wallets**: holders first funded within 24 hours of launch.
- **Dev record**: the deployer's other launches, how many rugged (−90% drawdown), and serial launching (5+ in 7 days).
- **Spam clones**: plain pools with 20+ airdropped holders, excluded from copycat checks.
- **Top 10 holders %**, excluding pools, routers and burn addresses.

The thresholds live in `THRESHOLDS` in `src/signals/compute.ts`. They are public on purpose: if you think one is wrong, open an issue with a token that proves it.

## Use it

```bash
npm install
npm test              # decoders, metadata and signals
npm run typecheck
npm run registry -- out   # registry as JSON
RPC_URL=https://… npm run recon -- 3000   # re-check the registry against the last 3,000 blocks
```

```ts
import { decodeLogs, computeSignals, LAUNCHPADS } from './src';
```

## Contributing

Issues and PRs are welcome, especially:

- a launchpad or contract we don't recognise yet (include a transaction hash),
- a token where a signal is clearly wrong,
- decoder fixes with a test.

This repository is mirrored from Rushr's main codebase. Accepted PRs are applied there and come back here with the next sync, so your commit may show up re-applied rather than merged directly.

## License

[AGPL-3.0](LICENSE). If you run a modified version as a service, you must publish your changes too.

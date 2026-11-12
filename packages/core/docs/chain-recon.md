# Robinhood Chain recon (2026-11-11)

What the indexer must watch, confirmed on-chain through the Alchemy RPC. Registry: `src/chain/robinhood.ts`. Re-check anytime with `npm run recon -- 3000`.

## Chain
- Chain ID 4663 (Arbitrum Orbit / Nitro), native ETH.
- **Block time ≈ 0.11 s** (measured over 10,000 blocks), about **6,500 logs/min**. Ingest with *filtered* `eth_getLogs` over block ranges (≤1,000 blocks per call), never per-block receipts.
- Blockscout (`robinhoodchain.blockscout.com`) API is behind a Cloudflare bot challenge, so **don't depend on it** from servers. Use Alchemy instead:
  - `alchemy_getAssetTransfers` (`category: external, internal`, `order: asc`) → a wallet's **first funder** and first-seen time. Verified working on 4663.
  - Same call with `contractAddresses` + `erc20` → a token's first transfer (creation tx).
- Cost: continuous indexing will exceed Alchemy's free tier; budget pay-as-you-go.

## Quote assets
| Asset | Address |
| --- | --- |
| Native ETH (v4 currency 0) | `0x0000…0000` |
| WETH | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` |
| USDG (Global Dollar) | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` |
| Stock tokens used as Doppler numeraires | SPCX `0x4a0e…5eea`, TTWO `0x5e81…9786`, NVDA `0xd060…9eec` |

## DEX
- **Uniswap v4** PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951` is where memecoins live: **1,357 pool inits in 12 h** (vs 279 v2 pairs, 66 v3 pools). PositionManager `0x58da…4fa7`, Universal Router `0x8876…0904`, Quoter `0x8dc1…8f94`.
- Uniswap v3 factories: `0x1f7d…2efa`, `0xe7fe…dad7`. v2 factories (UNI-V2): `0x8bce…937f`, `0x0d1e…4afd`.

## Other DEXes (recon 2026-11-12, from PONS pools)
Older tokens trade mostly outside Uniswap v4. PONS on DexScreener (24h $8.0M): Ramses $3.1M, Uniswap v4 $2.0M, Aero $1.4M, Uniswap v3 $0.75M, up $0.44M, Metric $0.24M, then Topaz, Nami, Uniswap v2, giga, robinswap.

| Venue | Factory | Swap event |
| --- | --- | --- |
| Uniswap v3 | `0x1f7d…2efa` | v3 `Swap` `0xc42079f9…` |
| Ramses (CL) | `0xe0c4…54a8` | v3 `Swap` |
| Aero (CL, Slipstream-style, dynamic fee) | `0xc63d…e136` | v3 `Swap` |
| up | `0x1ac9…b7f3` | v3 `Swap` |
| Topaz | `0xaa58…8ffb` | v3 `Swap` |
| Nami | `0xdedb…bda2` | v3 `Swap` |
| robinswap | `0xea56…3748` | v3 `Swap` |
| giga | `0xece6…e20b` | PancakeSwap v3 `Swap` `0x19b47279…` (two extra protocol-fee words) |
| Uniswap v2 | `0x8bce…937f` | v2 `Swap` `0xd78ad95f…` |
| Metric | (no token0/token1) | custom `0xcad09799…`, **not decoded yet** |

- v3 amounts are the **pool's** deltas (positive = paid into the pool): the swapper buys when the token amount is negative.
- The indexer doesn't watch factories: any address emitting one of these Swap events is resolved once with `token0()/token1()/factory()` and tracked if one side is a tracked token and the other a quote. Unlisted factories get venue `other`.
- Chain-wide volume (measured over 9 min): v3 Swap 276 logs/min (~240 KB/min of JSON), v2 9/min, v4 Swap 306/min, Transfer 2,160/min. About 224 v3 pools were active.
- PONS's own Transfer history is ~14M logs (block 8,963,150 onward). Alchemy caps any-range `eth_getLogs` at 10K logs per response (or 5,000 blocks with no cap).

## Launchpads (launches per 12 h)
| Launchpad | Launches | How to detect | How trades appear |
| --- | --- | --- | --- |
| **Doppler** (Orbofi and others) | 251 | Airlock `0xeb7c…0862` `Create(asset, numeraire, initializer, poolOrHook)`; v4 hook `0x4e34…a544` | v4 `Swap` on PoolManager; `Migrate(asset, pool)` on graduation |
| **PONS** | 215 | Launcher `0xe33e…2948`, topic `0xdcacba5e…` → `[token, curve, creator]` + dev buy | Per-token **curve contract** emits `ponsBuy` / `ponsSell`. At ~4.2 ETH the curve emits `ponsGraduate` (`0xf8d37a90…`) and liquidity moves to a v4 pool with the **PONS v2 hook** `0xe5e7…e044` (example: real ZOLVA `0x8e04…681f`, graduation tx `0xf24af8bf…`) |
| **lift.fun** | 84 | Launcher `0xc739…89c6`, topic `0x6f0c4668…` (name, symbol, `api.lift.fun` metadata URI); v4 hook `0x2c66…2acc` | v4 `Swap`; dev buy event `0x34b6bd41…` in the launch tx |
| Vorta (one bot deployer) | 73 | v4 hook `0x177d…28c4` | v4 `Swap`; treat as serial-launcher spam |
| Plain / other v4 hooks | 781 | v4 `Initialize` with no or unknown hook | v4 `Swap` |

Decoded examples:
- Doppler create (CAT, USDG-paired): `0xe93f9204d470f4522b3271b508dcc0e953be936c226f0e5b6c9daac2cc0dfaca`
- lift.fun launch ("family"): `0xac9c1644b2fe2d0452ce6eff1e92e0b303a86b940afdfebab72f7dbdf4669712`
- PONS launch (EUNO): `0x35b1787339eeeb025436236a9cb33f86b2ab90dc0abd00963c5f415dc6834ffd`; PONS launch of NORA: `0xa591b30fec407086aac41244dfb1727b5fc981a9d54032d4ae13923775582082`
- PONS curve buy: `0xa47a799a20a614695d5ed3b2885f8c8c62b7a8ff7181eb1d967a9f6acf7cc864`

## Who is the trader?
v4 `Swap.sender` is a router, and many txs come through the ERC-4337 EntryPoint (`0x5ff1…2789`), so `tx.from` can be a bundler. The trader = **the wallet that receives (buy) or sends (sell) the token in that tx**, ignoring `INFRA_ADDRESSES`. No extra RPC calls needed: use the token `Transfer` logs in the same tx.

## Status columns (New / Almost bonded / Migrated)
- **Migrated**: Doppler `Migrate`, or a token whose main pool is plain v2/v3/v4 (no launchpad hook).
- **Bonding / New**: launchpad tokens not yet migrated; "New" = age under a threshold, "Almost bonded" = progress above ~70%.
- PONS graduation is confirmed (see table). Still to confirm: lift.fun graduation.

## Tokens launched before the indexer started
When a swap hits a v4 pool the indexer never saw created, it resolves the pool via `PositionManager.poolKeys`, and tracks the token if it's under 7 days old: full transfer history (holders) plus the first ~66s of trades (bundle/sniper signals). If that launch window can't be fetched, `tokens.launch_indexed = false` and those signals show as not measured.

## GMGN as a second source
GMGN has an official **OpenAPI** (CLI repo `GMGNAI/gmgn-skills`) that lists `robinhood` as a chain, including `market trenches` (`new_creation` / `near_completion` / `completed`, filterable by launchpad), token info, security, holders and top traders. API key: register an Ed25519 public key at `gmgn.ai/ai` (do it under the Rushr identity). Reported rate limit ~20 req/s with request weights.
Use it to **cross-check** our numbers, launchpad coverage and bonding progress during development. It is not the terminal's live backend: rate limits, terms and a competitor dependency make our own indexer the source of truth.

## Open items
- lift.fun graduation event and bonding target.
- Exact field layout of the PONS launch event's data words (creator vs. pool).
- Doppler `Migrate` destination for Robinhood (no migrations seen in the 12 h sample).
- Map Doppler frontends (Orbofi factory `0x8212…94ff`, others) for nicer launchpad labels.

# Contributing to Rushr

Rushr is open social trading, built by the community, for the community. Issues and pull requests are welcome.

## Good first contributions

- **Launchpads and contracts we miss.** Robinhood Chain moves fast. Add factories, hooks and events to the chain registry in [`packages/core/src/chain`](packages/core/src/chain), with a decoder test using a real transaction.
- **Signals that are wrong.** If a token gets the wrong verdict (a false "serial dev", a missed bundle), open an issue with the token address and what you expected. Fixes go in [`packages/core/src/signals`](packages/core/src/signals) with a fixture test.
- **Agents.** Build an agent against the public API ([llms.txt](packages/agents/llms.txt)) and tell us what's missing.
- **UI and copy.** The terminal is in [`apps/web/components/terminal`](apps/web/components/terminal), the landing in [`apps/web/components/landing`](apps/web/components/landing).

## How to send a change

1. Open an issue first for anything bigger than a small fix, so we can agree on the approach.
2. Fork, branch from `main`, keep the change focused.
3. Run `pnpm typecheck`, `pnpm lint` and `pnpm test`. Add or update tests for decoders and signals.
4. Open a pull request that says what changed and how you checked it (a token address, a screenshot, test output).

## Ground rules

- **Never commit secrets.** RPC keys, database URLs and tokens live in gitignored `.dev.vars` / `.env.local` files.
- **Non-custodial only.** Rushr never holds user keys or funds. Code that signs or sends transactions runs in the user's own wallet.
- **Mind the RPC.** Indexer changes that add ongoing RPC load (new subscriptions, broad `eth_getLogs`) need a note in the PR.
- **Be kind.** Disagree about code, not people.

By contributing you agree that your contribution is licensed under [AGPL-3.0](LICENSE).

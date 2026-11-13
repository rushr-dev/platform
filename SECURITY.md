# Security

Rushr handles trades for real people, so we take reports seriously.

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Use GitHub's private vulnerability reporting instead: **Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it, and the impact you expect.

We'll acknowledge the report within 72 hours, keep you updated while we fix it, and credit you when it's disclosed (unless you'd rather stay anonymous).

## Scope

- The web app (rushr.trade, app.rushr.trade) and the API (api.rushr.trade)
- Trade building and routing (`packages/trade`) and the contracts (`contracts`)
- Sign-in, invites and agent API keys (`packages/agents`, `apps/indexer/src/agents`)

Out of scope: third-party services (Privy, Cloudflare, Robinhood Chain RPCs), social engineering, and denial-of-service through volume alone.

## Never

Rushr staff will never ask for your seed phrase, private key or a signature you don't understand.

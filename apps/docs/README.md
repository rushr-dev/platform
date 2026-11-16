# Rushr docs

The docs site at [docs.rushr.trade](https://docs.rushr.trade): [Astro Starlight](https://starlight.astro.build), static, with Pagefind search and `llms.txt` / `llms-full.txt` for agents ([starlight-llms-txt](https://github.com/delucis/starlight-llms-txt)). Served by Cloudflare Workers as static assets (`wrangler.jsonc`, no worker script).

Pages are Markdown in `src/content/docs`. Write only what the code and the live API do today, and check claims against the repo. The agent API pages follow `packages/agents/llms.txt`, which stays the source of truth.

Requires Node 22.23.4 or later (Astro 7).

```bash
pnpm --filter @rushr/docs dev       # http://localhost:4321
pnpm --filter @rushr/docs build     # dist/, checks every internal link
pnpm --filter @rushr/docs preview   # serves dist/ with wrangler on :8791
pnpm --filter @rushr/docs deploy    # build + wrangler deploy (maintainers)
```

Brand: `src/styles/rushr.css` (light paper by default, the terminal palette in dark mode) and the overrides in `src/components`.

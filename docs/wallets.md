# Wallets and custody: fast, popup-free, non-custodial

Status 2026-11-12: **decided.**
- Provider: **Privy**.
- Model: a policy-limited, user-revocable session signer. Our authorization key sits in a KMS (provider to be chosen, behind an interface).
- `RushrRouter`: approved to build, **audit-gated**. One-click server signing stays off until an independent audit; until then every trade needs a wallet confirmation.
- Default caps: **0.25 ETH per trade, 1 ETH per rolling 24 h, 30-day grants**, adjustable per user.
- Nothing has been signed. No account exists until the founder creates the Privy dev app.

## Questions for Privy (founder to ask when creating the dev app)
1. **Chain 4663 tier:** are transaction policies (`ethereum_transaction` and `ethereum_calldata` conditions) enforced for embedded wallets on Robinhood Chain (`eip155:4663`, custom RPC)? If 4663 is below Tier 2, what does it take to raise it?
2. **User-owned policies:** can a policy's `owner_id` be the **user's own key quorum** (the embedded wallet's owner)? We need it so that neither our app secret nor our authorization key can edit or delete the policy attached to our signer.
3. **Per-signer revoke:** can the user remove **one** signer (e.g. a single agent) while keeping the others? The client SDK's `removeSigners` appears to remove all of them.
4. **Stateful caps:** can we use one aggregation (sum of `value` over a rolling 24 h, `group_by` wallet) across all users within the 10-aggregations-per-app limit? Is there a plan to close the race between concurrent requests?
5. **Signer limits:** what is the maximum number of signers per wallet (quick-trade plus up to ~10 agents) and of policies per app (one per user per signer)?
6. **Latency and limits:** what are the signing latency and rate limits from Cloudflare Workers (APAC, near `ap-southeast-1`), and in which region are the TEEs?
7. **Pricing:** an Enterprise quote for ~10k–100k MAU and ~1M signatures/month (published pay-as-you-go comes to ≈ $11.5–16k/month).
8. **Exit:** if Privy is unavailable, what is the recovery path besides user export? Is there an SLA?

**Direction (founder):** every user gets an embedded, self-custodial, exportable wallet. Once, the user grants Rushr's server a **revocable, policy-limited signer**, so quick-buy needs no popup. Provider-enforced policies fence that signer, so a compromised Rushr server can't drain users.

**Recommendation in one line:** use **Privy** embedded wallets with one **session signer** (P-256 authorization key, held in a cloud KMS) per purpose: quick-trade and each in-app agent. Each signer carries a per-user Privy **policy owned by the user**: only Rushr's two router contracts, approvals only to those routers, value caps per tx and per rolling 24 h, an expiry, and everything else denied. The routers force the output to the trader. **Turnkey** is a close second and the fallback. The design depends on one Rushr contract being audited: a router that builds Uniswap routes itself (see the threat model).

---

## 1. Comparison

Sources were checked on 2026-11-12. "Unverified" marks claims we couldn't confirm in vendor docs.

| | **Privy** (Stripe) | **Turnkey** | **Dynamic** (Fireblocks) | **ZeroDev Kernel + session keys** |
| --- | --- | --- | --- | --- |
| **Robinhood Chain (4663)** | Custom chain via viem `defineChain` + RPC override (all EOA wallet features). Not on the chains page, but Privy's own agent recipe trades on `eip155:4663`, and Robinhood uses Privy (Robinhood Earn, Arcus). Transaction policies need chain **Tier ≥2**: confirm 4663's tier with Privy. Sponsorship needs Tier 3: unverified. [chains](https://docs.privy.io/basics/react/advanced/configuring-evm-networks.md), [recipe](https://docs.privy.io/recipes/agent-integrations/robo-advisor-agent.md), [Robinhood](https://privy.io/blog/bringing-global-financial-markets-onchain-with-robinhood) | **Supported, Tier 4** (tx parsing and policies), announced 2026-07-01. We broadcast via our own RPC. [blog](https://www.turnkey.com/blog/robinhood-chain-support) | Custom EVM network via `overrides.evmNetworks`; not listed natively. [docs](https://www.dynamic.xyz/docs/react/chains/adding-custom-networks) | **Live** since 2026-07-01, with Kernel v3.1/3.3, permissions, bundler and paymaster. Every contract we need is already deployed on 4663 (Agents notes). [blog](https://zerodev.app/blogs/zerodev-is-live-on-robinhood-chain), [Robinhood AA docs](https://docs.robinhood.com/chain/account-abstraction) |
| **Delegated signing model** | The user adds a **signer** (our key quorum: a P-256 authorization key) with `policyIds`. The TEE signs when our request carries a valid authorization signature, with no user present. [add signers](https://docs.privy.io/wallets/using-wallets/signers/add-signers.md) | Per-user **sub-org**. A "delegated access" user (our P-256 API key) gets a scoped `ALLOW` policy, then the user becomes the **only root**. Our parent org can read but not write sub-orgs. [delegated access](https://docs.turnkey.com/concepts/policies/delegated-access-backend) | "Delegated access": an MPC reshare gives us a key share plus a per-wallet API key over a webhook. **Enterprise plan only.** [docs](https://www.dynamic.xyz/docs/overview/wallets/embedded-wallets/mpc/delegated-access/overview.md) | On-chain: a permission validator (signer + policies) is installed on the user's Kernel account, and our backend holds the session private key. [permissions](https://docs.zerodev.app/sdk/permissions/intro) |
| **Contract and selector allowlist** | Yes: `ethereum_transaction.to` plus ABI-decoded `ethereum_calldata` (function and arguments). Default deny, DENY wins. [policies](https://docs.privy.io/controls/policies/overview) | Yes: `eth.tx.to`, `function_name`, `contract_call_args[...]` once the ABI is uploaded (structs and arrays supported). [language](https://docs.turnkey.com/concepts/policies/language), [ABIs](https://docs.turnkey.com/concepts/policies/smart-contract-interfaces) | Address allow/deny only. Selectors and arguments: not documented. [rules](https://www.dynamic.xyz/docs/overview/wallets/embedded-wallets/mpc/policies/creating-rules.md) | Yes: CallPolicy target + selector + positional argument conditions (`EQUAL`, `ONE_OF`, `LESS_THAN`…), enforced **on-chain**. [CallPolicy](https://docs.zerodev.app/sdk/permissions/policies/call) |
| **Argument conditions (e.g. `approve.spender ∈ routers`)** | Yes (calldata fields). There's no "self" variable, so recipient pins are per-wallet literals. | Yes (`contract_call_args`). No "self" variable, but policies live per sub-org anyway. | Not documented | Yes (static ABI words; nested bytes can't be decoded) |
| **Per-tx value cap** | Yes (`value`) | Yes (`eth.tx.value`) | Yes (`maxPerCall`) | Yes (`valueLimit`) |
| **Per-day / cumulative cap** | **Yes**: stateful rolling sums over 1–72 h, `group_by`, max 10 aggregations per app. **Can race** under concurrent requests ("disaster prevention"). [stateful](https://docs.privy.io/controls/policies/stateful-policies.md) | **Not found** (stateless per request) | Yes: rolling `spendWindows` (early access). [advanced](https://www.dynamic.xyz/docs/embedded-wallets/mpc/policies/advanced-conditions.md) | No value-over-time policy built in. RateLimit counts ops, not value; a custom policy would need an audit. |
| **Expiry** | `system.current_unix_timestamp` conditions | Not found as a field (revoke instead) | Not documented | TimestampPolicy |
| **EIP-712 (Permit2) rules** | Domain and message conditions: pin `verifyingContract`, `chainId`, `spender` | `eth.eip_712.{domain,primary_type,typed_message}` | Not documented | SignaturePolicy (details unverified) |
| **Who can change the policy** | Whoever the policy's `owner_id` names. **Set it to the user's key quorum**: without an owner, our app secret alone can rewrite it. [create policy](https://docs.privy.io/controls/policies/create-a-policy.md) | After `UPDATE_ROOT_QUORUM` the user is sole root, so we **cannot** change policies. Strongest guarantee of the four. | Policy layers; wallet and signer level are early access | Only the account owner (on-chain) |
| **Signing latency** | ~100 ms co-located, <200 ms end to end (vendor). [latency](https://privy.io/blog/reducing-trading-latency-on-privy) | 50–100 ms (vendor) | "Sub-second" (TSS-MPC) | Local sign in ms, then bundler and inclusion, ~1–3 s (unverified) |
| **Key custody, export, recovery** | Nitro Enclaves, 2-of-2 Shamir rebuilt only inside the TEE. User export via HPKE. No exit path documented beyond "export while up". [architecture](https://docs.privy.io/security/wallet-infrastructure/architecture.md), [export](https://docs.privy.io/wallets/wallets/export) | Nitro Enclaves on the **open-source QuorumOS**. HPKE export to the user. Recovery via passkeys or email OTP. [export](https://docs.turnkey.com/wallets/export-wallets), [QOS](https://github.com/tkhq/qos) | TSS-MPC 2-of-2 or 2-of-3. The 2-of-3 option adds cloud-backup **independent recovery**, which is a real exit path. | The owner key lives wherever you choose. Kernel is open source and works with any bundler. |
| **User revoke** | `removeSigners` / REST `additional_signers`, plus a prebuilt UI. Revoking a single signer: partly verified. [revoke](https://docs.privy.io/wallets/using-wallets/signers/remove-signers) | User (root) deletes our user, key or policy. Instant and free. We build the UI. | Widget: Delegated Wallets → Revoke | `uninstallPlugin` userop: on-chain, costs gas, needs the owner |
| **Pricing at 10k–100k MAU, ~1M signatures/mo** | PAYG: $2,000 base + $0.05/MAU over 10k + $0.01/signature over 50k ≈ **$11.5k–16k/mo**. Enterprise "as low as $0.001/signature" (≈$1k). [pricing](https://www.privy.io/pricing) | Pro: $0.05/signature = **$50k/mo**. Enterprise from $0.0015/signature (≈$1.5k). [pricing](https://www.turnkey.com/pricing) | Growth $249 + $0.05/MAU; **delegated access needs Enterprise** (custom). [pricing](https://www.fireblocks.com/dynamic-pricing) | ZeroDev Scale $399 per 1M credits at 20 credits/userop (1M ops → Enterprise). Or Pimlico ≈ $0.0075/userop ≈ $7.5k plus gas surcharges. [ZeroDev](https://zerodev.app/pricing), [Pimlico](https://www.pimlico.io/pricing) |
| **Audits, SOC 2** | SOC 2 Type II. Cure53, Zellic, Doyensec, SwordBytes. Private HackerOne. 2026-08-06 Metabase vendor breach exposed emails only (per Privy). [security](https://www.privy.io/security) | SOC 2 Type II. Open-source enclave OS. Trail of Bits engagement (scope unverified). Disclosure program. No incidents found. [trust center](https://docs.turnkey.com/security/trust-center) | SOC 2 Type II, Cure53 | Kernel v3.0 audited (ChainLight). **No audit found covering permissions / CallPolicy v0.0.5.** No SOC 2 (it's on-chain code). |
| **Cloudflare Workers** | **Yes**: `@privy-io/node` lists Workers. Or plain REST: RFC 8785 canonical JSON, ECDSA P-256/SHA-256, DER, base64 in `privy-authorization-signature`. [setup](https://docs.privy.io/basics/nodeJS/setup.md), [direct](https://docs.privy.io/controls/authorization-keys/using-owners/sign/direct-implementation.md) | Likely: `@turnkey/api-key-stamper` is pure JS (`@noble/curves`), but not officially stated. A REST `X-Stamp` (P-256 signature over the body) is easy to build with WebCrypto. [stamps](https://docs.turnkey.com/developer-reference/api-overview/stamps) | **No**: the server SDK needs native MPC addons and excludes Workers. [docs](https://www.dynamic.xyz/docs/node/wallets/server-wallets/overview.md) | Likely (viem-based TS), unverified |
| **Multiple signers (agents)** | Yes: several key quorums per wallet, each with its own policy | Yes: N non-root users, each with its own keys and policies, independently deletable. [agentic wallets](https://docs.turnkey.com/features/policies/delegated-access/agentic-wallets.md) | Not documented | Yes: one permission validator per agent |
| **Known trading users** | pump.fun, Bankr, Vector, Arcus (on Robinhood Chain), Robinhood | **Axiom**, o1.exchange, Genius, Defined. [Axiom](https://www.turnkey.com/customers/axiom-global-defi-trading-platform) | DFlow, Lighter, Kraken | Many 4337 apps; Robinhood's docs use Kernel |

### Verdict
- **Privy (recommended):**
  - It's the only option with **rolling per-day value caps**, plus full calldata and EIP-712 conditions.
  - Workers support is official, and the authorization-signature scheme is documented.
  - It has a Robinhood relationship with live 4663 usage, and ~100 ms signing.
  - Multiple signers per wallet cover agents.
  - Two things to confirm with Privy before building:
    1. 4663's chain tier supports transaction policies.
    2. A policy's `owner_id` can be the user's key quorum, so Rushr can't loosen it.
- **Turnkey (fallback, near tie):**
  - It has the strongest "we can't change it" guarantee (user is sole root of their sub-org) and an open-source enclave OS.
  - 4663 is explicitly Tier 4, and Axiom proves it at trading scale.
  - It loses on cumulative caps (none), and its Workers support isn't official.
  - Pick Turnkey if Privy can't confirm the two points above.
- **Dynamic:** excluded. Its server SDK can't run on Workers, delegation needs Enterprise, and it has no calldata or typed-data policies.
- **ZeroDev session keys:** the strongest guarantees (on-chain, survive even a vendor compromise), but 1–3 s bundler latency, gas to grant and revoke, and no audit found for the permission modules. Keep it as the **opt-in "maximum safety" mode** later, and as the path for users who bring an external wallet (7702 → Kernel). It isn't the default quick-trade path.

---

## 2. Threat model

**Assets:** the user's ETH, USDG and token balances in their embedded wallet.

**Trust domains:**
- the user (passkey or OTP, and the Privy owner role)
- Rushr's server (builds trades, holds the authorization key)
- the wallet provider's TEE (enforces policy, signs)
- the chain (Rushr router contracts)

### What an attacker gets under each design

| Attacker has… | Naive design (server signer may call the Universal Router directly) | **Recommended design** |
| --- | --- | --- |
| **Rushr server** (app secret + authorization key) | **Total loss.** UR `commands` are opaque bytes, so no provider policy can see recipients. One `execute` with `SWEEP`/`TRANSFER` to the attacker drains the wallet. ERC-20 approvals and Permit2 to the attacker drain the tokens. | Can only call the Rushr routers, which always pay output to `msg.sender` (the user). Can't transfer, can't approve other spenders, can't sign 7702 or arbitrary messages. **Residual risk:** *bad but valid trades*: buying into a pool the attacker controls (bounded by per-tx and per-day ETH caps), or selling the user's tokens into such a pool (see mitigations). |
| **Authorization key only** | Same as above | Same residual risk. KMS signing plus alerts shrink the window. |
| **App secret only** | Could rewrite policies if they have no owner | Can't sign (needs the authorization key) and can't loosen user-owned policies |
| **Provider compromise** (TEE or operator) | Total loss for every design that uses that provider | Same. That's the vendor-trust assumption; user export and the ZeroDev opt-in mode reduce it. |
| **User session hijack** (phishing the user's login) | Withdrawals possible | Withdrawals need the user's **passkey or 2FA step-up**, never the server signer |

### Mitigations (each needed)
1. **Every trade goes through Rushr's routers, with the recipient forced to `msg.sender`.**
   - `RushrCurveRouter` already does this for PONS curves.
   - For Uniswap paths we need **`RushrRouter`**, a small contract that takes a **structured route** (v4 pool key / v3 fee path / v2 path, amount, `minOut`, deadline) and **builds the Universal Router commands itself**, with no arbitrary `commands` argument. Output goes to the router, the fee is taken, and the rest goes to `msg.sender`.
   - Wrapping UR with a pass-through `commands` argument would **not** be safe: the attacker would just route the input to themselves.
   - This contract is a **deploy, so it's audit-gated**, and it's a prerequisite for server signing on Uniswap routes.
2. **Policy allowlist, default deny** (Privy policy JSON in section 3):
   - `to ∈ {RushrRouter, RushrCurveRouter}`, `chain_id == 4663`
   - ERC-20 `approve` only with `spender ∈ {RushrRouter, RushrCurveRouter}`; no Permit2 at all on this path
   - deny plain ETH transfers (`value > 0` to anything but the routers), ERC-20 `transfer`/`transferFrom`, all EIP-712 and `personal_sign`, and type-4 (7702) transactions
3. **Caps:** per-trade ETH `value` cap and a rolling 24 h sum (Privy stateful aggregation, `group_by` wallet). User-adjustable defaults, e.g. **0.25 ETH per trade, 1 ETH per day**. Privy's cap can race under concurrency, so the server also serialises signing per wallet. That doesn't help if the server itself is compromised, which is why caps are a bound, not the only defence.
4. **Expiry:** the policy carries `current_unix_timestamp < grant + 30 days`. Re-granting is one click with the user present.
5. **Withdrawals and exports:** only through the user's own owner session (passkey or OTP plus Privy MFA). The server signer can never send funds anywhere.
6. **Authorization key in a cloud KMS** (P-256, non-exportable). Workers call a narrow signing service that only signs Privy request payloads, under separate credentials, with audit logs. Rotate it, and keep a separate key per purpose (quick-trade, each agent).
7. **Policy ownership:** set `owner_id` to the user's key quorum, so neither our app secret nor our authorization key can loosen a policy. With Turnkey, the user is sole root by construction.
8. **Sell side, adversarial pools** (the residual risk that caps don't bound, since sells are paid in tokens):
   - `RushrRouter` only accepts pools of known kinds: v4 hooks in a **timelocked allowlist** (none, PONS v2, lift.fun, Doppler), v2/v3 from Uniswap's factories only.
   - The router rejects a sell whose `minOut` is below (1 − max slippage) × its own on-chain spot read of the chosen pool. This only partly helps: a thin attacker pool still has a "fair" spot.
   - A **timelocked pool registry** (24 h delay, guardian pause by a separate multisig) for anything beyond canonical pools, so a malicious pool is visible for a day before it's usable.
   - Large sells (above the ETH-equivalent of the trade cap) need user presence.
9. **Anomaly alerts** outside the signing path:
   - an independent watcher on chain logs and Privy webhooks: sudden signature volume, trades into pools under N minutes old, repeated `minOut` near zero, and cap hits
   - a kill switch: we can't revoke user-owned grants ourselves, so the switch is to **stop signing** and `pause` the routers (guardian multisig, separate from the server)
10. **Transparency:** a "Permissions" page lists each signer, its caps, expiry and last use, with one-click revoke and export.

---

## 3. Recommended flow (Privy)

1. **Sign up** with email, X or a passkey (Privy auth). An embedded EOA is created on chain 4663, with the user as owner. Prompt for a passkey or MFA for withdrawals.
2. **Enable 1-click trading** (once, user present):
   - The server creates a per-user policy:
     ```json
     { "version": "1.0", "name": "rushr-quick-trade:<user>", "chain_type": "ethereum", "rules": [
       { "name": "trade via routers", "method": "eth_signTransaction", "action": "ALLOW", "conditions": [
         { "field_source": "ethereum_transaction", "field": "to", "operator": "in", "value": ["<RushrRouter>", "<RushrCurveRouter>"] },
         { "field_source": "ethereum_transaction", "field": "chain_id", "operator": "eq", "value": "4663" },
         { "field_source": "ethereum_transaction", "field": "value", "operator": "lte", "value": "250000000000000000" },
         { "field_source": "aggregation", "field": "eth_value_24h", "operator": "lte", "value": "1000000000000000000" },
         { "field_source": "system", "field": "current_unix_timestamp", "operator": "lt", "value": "<grant+30d>" } ] },
       { "name": "approve routers only", "method": "eth_signTransaction", "action": "ALLOW", "conditions": [
         { "field_source": "ethereum_calldata", "field": "approve.spender", "operator": "in", "value": ["<RushrRouter>", "<RushrCurveRouter>"], "abi": "<erc20 approve>" },
         { "field_source": "ethereum_transaction", "field": "value", "operator": "eq", "value": "0" } ] } ] }
     ```
     This is illustrative: the exact field names follow Privy's schema, and anything unmatched is denied.
   - The policy's owner is the user's key quorum.
   - The user calls `addSigners({ signerId: <rushr quick-trade key quorum>, policyIds: [policy] })`.
3. **One-click quick-buy:**
   - The UI sends `{ token, amount }`.
   - The server runs `prepareSwap(...)` (already in `packages/trade`) → structured route → `RushrRouter` calldata. It simulates with `eth_simulateV1`, signs via Privy (`eth_signTransaction`, authorization signature from KMS), and broadcasts to our RPC.
   - The ledger records the trade (`TradeRecord`).
   - Expected latency is about 100–200 ms signing plus RPC broadcast, then sequencer inclusion.
   - The first sell of a token also needs a one-time `approve(RushrRouter)`, also within policy.
4. **Revoke and export:** a Permissions page with "Revoke 1-click trading" (`removeSigners`) and "Export key" (Privy HPKE export) needs the user's passkey. Expiry auto-lapses the grant.

---

## Agents

**Model:** each in-app agent is its **own Privy signer on the owner's wallet**, with its own authorization key (KMS) and its own policy:
- allowed routers, per-trade and daily ETH caps, expiry
- optionally a token allowlist or denylist via router calldata conditions

Each one is revocable on its own from the Permissions page. Quick-trade and agents use the **same mechanism**, so one integration, one audit surface and one revoke UI cover both.

**Against the Agents stream's recommendation** (Kernel/ZeroDev session keys held only by user-controlled software, with "Rushr must never hold any key"):
- **Where they agree:**
  - A target/selector allowlist on the Universal Router alone is unsafe, so recipient forcing needs a Rushr router contract.
  - Caps, expiry and independent revocation per agent.
- **Where they differ:** the founder's new direction accepts that **Rushr holds a policy-limited signer**, which reverses the Agents stream's hard rule. The trade is: always-on hosted agents and popup-free trading, in exchange for trusting the provider's policy enforcement plus our KMS. On-chain enforcement (Kernel) would also survive a provider compromise.
- **Single approach covering both:** **Privy signers + Rushr routers** for quick-trade and hosted in-app agents. ZeroDev/Kernel stays as:
  1. an opt-in "on-chain enforced" mode for users who want guarantees independent of the provider (7702 → Kernel on their EOA, with the session key from the same KMS service)
  2. the route for external wallets, which can't get Privy signers
- **External / self agents** (SIWE-registered, their own wallets) are unchanged: they get unsigned transactions from `prepareSwap` and sign themselves.
- **Agents session should update `docs/agents.md`:**
  - In-app option B becomes "Privy signer per agent under the owner's wallet".
  - The "Rushr holds no key" rule becomes "Rushr holds only provider-policy-limited, user-revocable signer keys, in KMS, never able to transfer, approve other spenders, or exceed caps".

---

## Decisions for the founder
1. **Provider:** Privy (recommended) or Turnkey. Then create the dev account and app ID yourself, since we never create accounts or handle credentials, and ask the vendor:
   - **Privy:** the 4663 tier (transaction policies), user-owned policies, and an Enterprise quote at ~1M signatures/month
   - **Turnkey:** an Enterprise quote
2. **Accept the key-holding model** (policy-limited, revocable, KMS-held) as replacing the Agents stream's "no key" rule.
3. **Approve `RushrRouter`** (structured Uniswap routes, recipient forced, pool allowlist with timelock, guardian pause) for build and independent audit. It's required before server signing on Uniswap routes. Until then, quick-buy needs a wallet confirmation per trade.
4. **Default caps and expiry:** proposed 0.25 ETH per trade, 1 ETH per day, 30-day grants, user-adjustable.
5. **KMS:** which cloud (AWS KMS P-256 or GCP KMS) holds the authorization keys.

## Built so far (2026-11-12; nothing deployed, no real account or key)

### `contracts/src/RushrRouter.sol` (audit-gated, not deployed)
- **Structured routes:** `Route { kind (V2|V3|V4), token, quote (WETH, or ETH for v4), fee, tickSpacing, hooks }`. The contract builds the Universal Router v2.1 commands itself and takes **no arbitrary calldata**. Output always lands in the router and goes to `msg.sender`. `minOut` is checked on what the trader actually receives. The fee (0.5%, or 0.45% when referred) is taken in ETH.
- **Entry points:**
  - `buy`: any canonical v2/v3 pool, and v4 pools with allowlisted hooks.
  - `sell`: **timelocked allowlisted pools only**.
  - `sellAnyPool`: user-confirmed only, **never paused**, so users can always exit. The signer policy denies its selector.
- **Allowlists:** the operator queues hooks and sell pools, and anyone activates them after `delay` (≥10 min). The guardian (a separate multisig) can cancel or remove immediately, pause `buy`/`sell`, and rotate the operator. There's no owner and no upgrades; the fees, treasury and guardian are immutable.
- **Tests:**
  - 9 unit tests: validation, timelock, roles, pause, stray ETH, and pool keys shared with TypeScript.
  - 5 fork tests on the real Universal Router v2.1.2 and live pools:
    - buy then sell through v3, v2 and native-ETH v4 with exact 0.5%/0.45% fees
    - nothing left in our router, and the Universal Router's balances unchanged
    - `minOut` enforced on buy and sell
    - `sell` refused until the pool clears the timelock
    - a lift.fun-hooked v4 pool refused until its hook is allowlisted, then bought and sold
    - user exit while paused

  Run with `forge test`, and `ROBINHOOD_RPC_URL=… forge test --match-contract Fork`.
- **Compiler setting:** `evm_version` is now `cancun`. The Universal Router uses transient storage, and Robinhood Chain (ArbOS 61) runs Cancun.

### `packages/trade`
| Module | What |
| --- | --- |
| `rushr-router.ts` | `routeFromPool(pool)` (ETH/WETH Uniswap pools), `rushrPoolKey` (same as the contract's `poolKeyOf`), `buildRushrRouterSwap(quote, cfg, { sellMode })` → unsigned tx plus the `approve(RushrRouter)` approval |
| `policy.ts` | `buildSignerPolicy({ purpose, wallet, rushrRouter, curveRouter, caps })`: the Privy policy JSON. It allows the routers' `buy`/`sell` and router approvals on chain 4663, with per-trade and rolling-24 h caps and expiry; `sellAnyPool` is deliberately not allowed. `defaultCaps(now)`: 0.25 ETH, 1 ETH, 30 days |
| `signer.ts` | The `AuthorizationKey` (KMS boundary) interface; `PlaceholderKmsKey` (always refuses, until a KMS is chosen); `WebCryptoAuthorizationKey` (dev and tests only, imports Privy's `wallet-auth:` format); `PrivySessionSigner` (REST `POST /v1/wallets/{id}/rpc` `eth_signTransaction`, signed with an RFC 8785 canonical payload and DER P-256 signature); `createSessionSigner(env)` (returns `null` unless `WALLETS_ENABLED=1` and Privy is configured); `assertOneClickAllowed(cfg)` (refuses until `rushrRouter` is set **and** `rushrRouterAudited: true`) |

Verified:
- 63 unit tests pass. The signature produced by `PrivySessionSigner` verifies with WebCrypto against the canonical payload. Canonical JSON, DER conversion, policy contents, the gates and policy-denial handling are all covered.
- `signer`, `policy` and `agent` bundle for Workers (`workerd` conditions) with no Node built-ins.
- Not verified: Privy's live API. Header and field names follow Privy's docs and must be checked once the founder's dev app exists (questions at the top).

### Next, once the founder has the Privy dev app
1. Confirm the open questions.
2. Check `PrivySessionSigner` against Privy's dev environment, signing only, never broadcasting.
3. Pick the KMS and implement `AuthorizationKey` for it.
4. Add a Permissions page (grant, caps, revoke, export) in the terminal (Terminal stream).

One-click trading stays off until RushrRouter's independent audit; until then trades go through the wallet confirmation flow.

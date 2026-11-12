# Review checklist (before any deployment)

Status: **UNAUDITED, NOT DEPLOYED.** An independent reviewer confirms every item below. Deployment needs the Rushr founder's sign-off on all of them, plus constructor arguments and verified source on Blockscout.

## Threat model in one paragraph
Rushr's one-click trading lets a server-held session signer (Privy, policy-limited) sign trades for a user's own wallet. The wallet provider's policy allows only `RushrRouter.{buy,sell}`, `RushrPonsRouter.{buy,sell}` and ERC-20 `approve` to these two routers, with ETH caps per trade and per rolling 24 h. These contracts must therefore guarantee:
- swap output reaches only `msg.sender`;
- no call path lets a caller move a user's funds anywhere else;
- the damage a compromised signer can do is limited to bad-but-valid trades that the caps, the sell allowlist and the guardian bound.

## RushrRouter
1. **No arbitrary execution:** commands are built only from `Route` fields. Check that no `Route` value can make the Universal Router pay a third party: recipients are only `UR_MSG_SENDER` (this router) or `UR_ADDRESS_THIS`.
2. **Universal Router v2.1 encodings:**
   - `V2/V3_SWAP_EXACT_IN` carry a trailing `uint256[] maxHopSlippage`
   - v4 `ExactInputSingleParams` carry `maxHopSlippage` before `hookData`
   - `SETTLE` pays from the Universal Router's own balance (`payerIsUser = false`)
   - `TAKE`/`TAKE_ALL` recipients are mapped correctly

   Confirm these against the deployed router's source.
3. **Pool identity:** v2/v3 pools are derived by the Universal Router from Uniswap's factory and init code hash (only factories `0x1f7d…2efa` / `0x8bce…937f` are reachable). v4 pools are limited by `hookAllowed`. `poolKeyOf` matches the v4 PoolId and is unique per v2/v3 pool.
4. **Balances:**
   - Buys measure the router's token delta, then the trader's received delta.
   - Sells measure what the Universal Router actually received from `transferFrom`, then the router's ETH delta.
   - Stray tokens or ETH in the Universal Router can't be swept into or out of a trade.
5. **Allowlist and timelock:**
   - The operator can only queue; activation waits `delay`.
   - The guardian can remove or cancel at any time.
   - Removing a hook stops `buy` and `sell` on those pools, but `sellAnyPool` still checks hooks too. Decide whether exits through a de-listed hook should stay possible.
6. **Pause:** stops `buy` and `sell` only. `sellAnyPool` stays open by design (users can always exit).
7. **Adversarial pools (residual risk):** a compromised signer can buy into a canonical pool the attacker controls (bounded by ETH caps), and can only sell into allowlisted pools. Review the operator process for queueing pools and the guardian's monitoring.

## RushrPonsRouter
1. **Target trust:** `getLaunchedToken` on the real PONS factory (`0x7ed5…ec7e`) can't be made to return an attacker-controlled curve for a token, and its return layout (token, curve as the first two words) is stable. Verify against PONS's source, or get the PONS team's confirmation.
2. **Curve behaviour assumptions:**
   - `buy` sends tokens to `recipient` and refunds only to `msg.sender`
   - `sell` pulls exactly `tokensIn` (or less) via `transferFrom`
   - `graduated()` is final
   - no hidden callbacks to the caller

   Re-check if PONS upgrades the curve implementation.
3. **Fee math:** buy fee = `floor(value·bps/1e4)`, and after a graduation refund `floor(spent·bps/(1e4−bps))`; sell fee = `floor(gross·bps/1e4)`. No path charges more than `MAX_FEE_BPS`; rounding favours the user.
4. **ETH accounting:** `ethBefore = balance − msg.value` stays correct even if ETH was force-sent (selfdestruct). Force-sent ETH can only be swept to the next buyer's refund and can never block a trade. Decide whether that's acceptable.

## Both
1. **Reentrancy:** the lock covers every entry point and `receive`. External ETH sends happen last. The routers hold nothing between transactions.
2. **Token weirdness:** fee-on-transfer, no-return-value ERC20s (handled by `_call`), tokens that revert on `approve(0)`, blacklisting tokens, rebasing tokens.
3. **Slippage and MEV:** minimum outputs are checked on what the trader actually receives, and deadlines are enforced. Robinhood Chain has a sequencer, so confirm whether Timeboost or an express lane is enabled.
4. **Constructor arguments:**
   - fee 50 and referral fee 45 bps
   - guardian (a multisig, never the treasury key)
   - `delay`: recommend **≥ 24 h** for treasury changes
   - for RushrRouter, also the operator

   Fees, guardian and delay are immutable, so a wrong value means redeploying.
5. **Treasury timelock (`TreasuryTimelock`):**
   - only the guardian can queue or cancel
   - activation is impossible before `pendingTreasuryEta`
   - re-queueing restarts the delay
   - zero address rejected
   - events on queue, change and cancel
   - fees in flight use the treasury current at execution

   Check that no path changes `treasury` without the delay.
6. **EOA treasury (known risk):** the initial treasury is the founder's EOA `0x447a…5E40`. Confirm the key sits on a hardware wallet with regular sweeps, and that there's a plan (and the guardian's ability, tested) to `queueTreasury(safe)` before volume grows.
7. **Compiler:** solc 0.8.26, optimizer 10,000 runs, `evm_version = cancun`.
8. **Tests:** re-run `forge test` and the fork suites (`ROBINHOOD_RPC_URL=… forge test --match-contract Fork`) at a fresh block, and add your own cases.

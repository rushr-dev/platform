// Server-side honeypot check for agent buys (POST /trade/quote and /trade/build).
//
// Every agent BUY is checked with a simulated buy→sell round trip (probeTokenSafety: one eth_simulateV1
// call, nothing signed or sent) before Rushr returns a quote or builds a transaction:
// - the buy works but the sell reverts → `honeypot` (422), no override;
// - the check can't run (RPC or simulation error) or its buy leg fails → `safety_unverified` (503, retryable).
//   Fail closed, same rule as the web app: a buy is never let through as if it had passed.
// Sells are never checked or blocked (members must always be able to exit). PONS bonding-curve quotes are
// exempt: the token is PONS's own factory contract, sells go back to the curve, and the probe can't build
// curve trades.
//
// A passing result is cached per token for PASS_TTL_MS in this isolate, so an agent quoting repeatedly
// doesn't cost one simulation per quote. Failures and honeypots are never cached: the next call re-checks.
import type { TokenSafety } from '@rushr/trade/simulate';
import { fail } from './http';

export const PASS_TTL_MS = 10 * 60_000;
const passed = new Map<string, { at: number; result: TokenSafety }>();

/** What the agent sees about the check (in quote and build responses). */
export interface HoneypotCheck {
  checked: 'probe' | 'cached' | 'exempt';
  buyTaxBps: number | null;
  sellTaxBps: number | null;
  roundTripBps: number | null;
}

/**
 * Throws `honeypot` or `safety_unverified` for a buy that fails the check; returns what was checked
 * otherwise. `probe` runs the simulation (injected so tests and callers pick the quote and client).
 */
export async function checkBuy(token: string, venue: string, probe: () => Promise<TokenSafety>, now = Date.now()): Promise<HoneypotCheck> {
  if (venue === 'pons-curve') return { checked: 'exempt', buyTaxBps: null, sellTaxBps: null, roundTripBps: null };
  const key = token.toLowerCase();
  const hit = passed.get(key);
  if (hit && now - hit.at < PASS_TTL_MS) return view('cached', hit.result);
  let r: TokenSafety;
  try {
    r = await probe();
  } catch (e) {
    throw unverified(String(e instanceof Error ? e.message : e));
  }
  if (r.honeypot) {
    throw fail(422, 'honeypot', 'A simulated buy of this token works but selling it back reverts: it looks like a honeypot. Rushr will not quote or build a buy for it.', {
      check: view('probe', r),
    });
  }
  if (!r.buyOk || !r.sellOk) throw unverified(r.error ?? 'the simulated buy did not go through');
  passed.set(key, { at: now, result: r });
  return view('probe', r);
}

const view = (checked: HoneypotCheck['checked'], r: TokenSafety): HoneypotCheck => ({
  checked, buyTaxBps: r.buyTaxBps, sellTaxBps: r.sellTaxBps, roundTripBps: r.roundTripBps,
});

const unverified = (why: string) =>
  fail(503, 'safety_unverified', "Couldn't run the buy→sell honeypot check for this token right now, so Rushr won't quote or build the buy. Retry in a few seconds.", {
    retryAfter: 5,
    reason: why.slice(0, 200),
  });

/** Tests only. */
export function resetHoneypotCache() {
  passed.clear();
}

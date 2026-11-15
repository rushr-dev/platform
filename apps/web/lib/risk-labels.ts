/**
 * Risk labels (low / medium / high, the verdict line and the "I understand" step for high-risk buys) and the
 * copycat / launch-farm flags are hidden while the scoring is still being tested. The raw signals (holders, dev %,
 * bundled %, taxes, serial dev) still show, and honeypots are still blocked by the trade simulation. Turn the labels back on with
 * NEXT_PUBLIC_SHOW_RISK=1 at build time.
 */
export const SHOW_RISK = process.env.NEXT_PUBLIC_SHOW_RISK === '1';

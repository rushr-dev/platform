/** Number and time formatting shared by the terminal. */

export const nf = new Intl.NumberFormat('en-US');

export function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

/** Tiny token prices: $0.0₄5321 style, like most trenches terminals. */
export function price(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1) return `$${n.toFixed(4)}`;
  const s = n.toFixed(20);
  const zeros = s.slice(2).search(/[1-9]/);
  if (zeros < 4) return `$${n.toPrecision(4)}`;
  const sub = String(zeros).split('').map((d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)]).join('');
  return `$0.0${sub}${s.slice(2 + zeros, 2 + zeros + 4)}`;
}

export const pct = (n: number | null | undefined, digits = 1) => (n == null ? '—' : `${Number(n.toFixed(digits))}%`);

export const short = (a: string, head = 4, tail = 4) => `${a.slice(0, head + 2)}…${a.slice(-tail)}`;

export function age(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const HUES = ['#36d42a', '#ffb547', '#5ec8ff', '#ff7ab6', '#b58cff', '#ff6b5b', '#a6ff4d', '#4de0c2'];
export const hue = (address: string) => HUES[parseInt(address.slice(2, 6), 16) % HUES.length]!;

export const LAUNCHPAD_LABEL: Record<string, string> = {
  pons: 'PONS',
  doppler: 'Doppler',
  'lift.fun': 'lift.fun',
  lift: 'lift.fun',
  'uniswap-v4': 'Uniswap',
  vorta: 'Vorta',
};

/** Longer age for headers: "42s", "12m 5s", "5h 12m", "119d 4h". */
export function ageLong(fromMs: number, nowMs: number): string {
  const s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** Compact counts and token amounts: 950, 12.3K, 4.56M, 1.2B. */
export function compact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  if (a >= 1) return n.toFixed(a >= 100 ? 0 : 1);
  return n.toPrecision(2);
}

/** Signed dollars: +$1.2K / -$340. */
export const usdSigned = (n: number | null | undefined) => (n == null ? '—' : `${n >= 0 ? '+' : '-'}${usd(Math.abs(n))}`);

/** Signed percent with one decimal: +4.2% / -12.0%. */
export const pctSigned = (n: number | null | undefined, digits = 1) =>
  n == null || !Number.isFinite(n) ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;

export const EXPLORER = 'https://robinhoodchain.blockscout.com';
export const dexscreenerUrl = (token: string) => `https://dexscreener.com/robinhood/${token}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/**
 * "Jul 14, 2026" in UTC. Deliberately not toLocale*: the server and the browser can differ in
 * locale and time zone, and any difference in server-rendered text breaks hydration.
 */
export function dateUtc(iso: string | number): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
export const dateTimeUtc = (iso: string | number) => `${new Date(iso).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** Quote tokens (mirrors QUOTES / STOCK_QUOTES in @rushr/core, kept here to keep viem out of the client bundle). */
const QUOTE_LABEL: Record<string, string> = {
  '0x0000000000000000000000000000000000000000': 'ETH',
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 'WETH',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG',
  '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea': 'SPCX',
  '0x5e81213613b6b86eab4c6c50d718d34359459786': 'TTWO',
  '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec': 'NVDA',
};
export const quoteLabel = (q: string | null | undefined) => (q ? (QUOTE_LABEL[q.toLowerCase()] ?? short(q, 2, 2)) : 'ETH');

/** Counts: whole numbers under 1,000, then 1.2K / 3.4M. */
export const countFmt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? '—' : Math.abs(n) < 1000 ? String(Math.round(n)) : compact(n));

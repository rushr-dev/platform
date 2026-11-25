'use client';

import { ArrowSquareOut, CalendarBlank, Coins } from '@phosphor-icons/react';
import { useAuth } from '@/lib/auth';
import { fmtUnits } from '@/lib/balances';
import { useCashback, type CashbackRow } from '@/lib/cashback';
import { EXPLORER } from '@/lib/format';

/**
 * Own profile: the member's cashback, in dollars. 30% of every Rushr fee they pay comes back: it builds up with
 * every trade and is sent to their wallet every Sunday from the treasury Safe.
 */
const ETH = '0x0000000000000000000000000000000000000000';
const isEth = (t: string) => t.toLowerCase() === ETH;
const tokenAmt = (raw: bigint, t: string) => `${fmtUnits(raw, isEth(t) ? 18 : 6, isEth(t) ? 6 : 2) || '0'} ${isEth(t) ? 'ETH' : 'USDG'}`;
/** Fallback when the ETH price is unknown: the token amounts, e.g. "0.0012 ETH + 0.40 USDG". */
const tokens = (rows: CashbackRow[], pick: (r: CashbackRow) => bigint) => {
  const parts = rows.filter((r) => pick(r) > 0n).map((r) => tokenAmt(pick(r), r.fee_token));
  return parts.length ? parts.join(' + ') : '$0.00';
};
/** $0.08, and "<$0.01" for anything above zero that rounds away. */
function dollars(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
/** "Sunday, 29 Nov" from YYYY-MM-DD. */
function payoutDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(/^(\w+) /, '$1, ');
}

export function CashbackCard() {
  const { authenticated } = useAuth();
  const { data, state } = useCashback(authenticated);
  if (state === 'unavailable') return null;
  const rows = data?.cashback ?? [];
  const share = (data?.shareBps ?? 3000) / 100;
  const usd = data?.usd;
  const next = (r: CashbackRow) => BigInt(r.owed) + BigInt(r.pending);
  const show = (v: number | null | undefined, pick: (r: CashbackRow) => bigint) => (v != null ? dollars(v) : tokens(rows, pick));
  const paidOut = (data?.payouts ?? []).filter((p) => p.status === 'paid' && p.tx_hash).slice(0, 3);
  const day = data ? payoutDay(data.payout.next) : null;

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-surface p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Coins size={16} weight="fill" className="text-brand" /> Cashback
        </div>
        <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">{share}% of fees back</span>
      </div>

      {state === 'loading' ? (
        <div className="mt-3 h-9 w-40 animate-pulse rounded-lg bg-white/[0.05]" />
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted">
          Every trade earns cashback: {share}% of the Rushr fee you pay comes back to your wallet{day ? `, paid every ${data!.payout.weekday}` : ''}.
        </p>
      ) : (
        <>
          <div className="mt-3 text-xs text-muted">Next payout</div>
          <div className="mt-0.5 font-mono text-3xl font-semibold tracking-tight">{show(usd?.nextPayout, next)}</div>
          {day && (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
              <CalendarBlank size={13} /> Sent to this wallet on {day}. Nothing to claim.
            </p>
          )}
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-xl bg-white/[0.03] px-3 py-2">
              <div className="text-muted">Earned so far</div>
              <div className="mt-0.5 font-mono text-ink">{show(usd?.earned, (r) => BigInt(r.accrued))}</div>
              <div className="mt-0.5 text-[11px] text-muted">from {rows.reduce((n, r) => n + r.trades, 0)} trades</div>
            </div>
            <div className="rounded-xl bg-white/[0.03] px-3 py-2">
              <div className="text-muted">Paid to you</div>
              <div className="mt-0.5 font-mono text-ink">{show(usd?.paid, (r) => BigInt(r.paid))}</div>
            </div>
          </div>
          {paidOut.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs">
              {paidOut.map((p) => (
                <li key={`${p.batch}${p.fee_token}`} className="flex items-center justify-between text-muted">
                  <span>{payoutDay(p.batch)}</span>
                  <a href={`${EXPLORER}/tx/${p.tx_hash}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-mono text-ink hover:text-brand">
                    {p.usd != null ? dollars(p.usd) : tokenAmt(BigInt(p.amount), p.fee_token)} <ArrowSquareOut size={11} />
                  </a>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] text-muted">Dollar amounts at today&apos;s ETH price; paid in the ETH or USDG you paid the fee in.</p>
        </>
      )}
    </section>
  );
}

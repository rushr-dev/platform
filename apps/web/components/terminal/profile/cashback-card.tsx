'use client';

import { ArrowSquareOut, Coins } from '@phosphor-icons/react';
import { useAuth } from '@/lib/auth';
import { fmtUnits } from '@/lib/balances';
import { useCashback, type CashbackRow } from '@/lib/cashback';
import { EXPLORER } from '@/lib/format';

/**
 * Own profile: the member's cashback. 30% of every Rushr fee they pay comes back: it builds up with every trade
 * and is sent to their wallet in the weekly payout from the treasury Safe.
 */
const ETH = '0x0000000000000000000000000000000000000000';
const isEth = (t: string) => t.toLowerCase() === ETH;
const amt = (raw: bigint, t: string) => `${fmtUnits(raw, isEth(t) ? 18 : 6, isEth(t) ? 6 : 2) || '0'} ${isEth(t) ? 'ETH' : 'USDG'}`;
/** One line per fee token, e.g. "0.0012 ETH + 0.40 USDG". */
const total = (rows: CashbackRow[], pick: (r: CashbackRow) => bigint) => {
  const parts = rows.filter((r) => pick(r) > 0n).map((r) => amt(pick(r), r.fee_token));
  return parts.length ? parts.join(' + ') : amt(0n, ETH);
};
/** What the next payout sends: owed, plus anything already in a batch waiting for the Safe. */
const nextPayout = (r: CashbackRow) => BigInt(r.owed) + BigInt(r.pending);

export function CashbackCard() {
  const { authenticated } = useAuth();
  const { data, state } = useCashback(authenticated);
  if (state === 'unavailable') return null;
  const rows = data?.cashback ?? [];
  const share = (data?.shareBps ?? 3000) / 100;
  const paidOut = (data?.payouts ?? []).filter((p) => p.status === 'paid' && p.tx_hash).slice(0, 3);
  const minEth = BigInt(data?.payout.min[ETH] ?? '0');
  const eth = rows.find((r) => isEth(r.fee_token));
  const belowMin = eth != null && nextPayout(eth) > 0n && nextPayout(eth) < minEth;

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
          Every trade earns cashback: {share}% of the Rushr fee you pay comes back to your wallet, paid out every week.
        </p>
      ) : (
        <>
          <div className="mt-3 text-xs text-muted">Next weekly payout</div>
          <div className="mt-0.5 font-mono text-2xl font-semibold tracking-tight">{total(rows, nextPayout)}</div>
          <p className="mt-1 text-[11px] text-muted">
            {belowMin
              ? `Paid once it reaches ${amt(minEth, ETH)}; until then it carries over to the next week.`
              : 'Sent to this wallet automatically. Nothing to claim.'}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-xl bg-white/[0.03] px-3 py-2">
              <div className="text-muted">Earned so far</div>
              <div className="mt-0.5 font-mono text-ink">{total(rows, (r) => BigInt(r.accrued))}</div>
              <div className="mt-0.5 text-[11px] text-muted">{rows.reduce((n, r) => n + r.trades, 0)} trades</div>
            </div>
            <div className="rounded-xl bg-white/[0.03] px-3 py-2">
              <div className="text-muted">Paid to you</div>
              <div className="mt-0.5 font-mono text-ink">{total(rows, (r) => BigInt(r.paid))}</div>
            </div>
          </div>
          {paidOut.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs">
              {paidOut.map((p) => (
                <li key={`${p.batch}${p.fee_token}`} className="flex items-center justify-between text-muted">
                  <span>Week of {p.batch}</span>
                  <a href={`${EXPLORER}/tx/${p.tx_hash}`} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-mono text-ink hover:text-brand">
                    {amt(BigInt(p.amount), p.fee_token)} <ArrowSquareOut size={11} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

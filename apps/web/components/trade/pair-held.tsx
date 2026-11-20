'use client';

import Link from 'next/link';
import type { useQuickTrade } from './use-quick-trade';

/**
 * Shown after a pair trade (a curve priced in another token, e.g. AMC priced in ANT) stopped between its two
 * legs: the user now holds the pair token. Never a silent loss: say how much, and offer to finish the trade
 * or swap the pair token back to ETH (buys), or to retry the swap to ETH (sells).
 */
export function PairHeldNote({ q }: { q: Pick<ReturnType<typeof useQuickTrade>, 'pairHeld' | 'resumePair' | 'dismissPair' | 'status'> }) {
  const h = q.pairHeld;
  if (!h) return null;
  const busy = q.status.kind === 'sending' || q.status.kind === 'pending' || q.status.kind === 'quoting';
  const sym = h.legs.pairSymbol;
  const btn = 'rounded-lg px-2.5 py-1 text-xs font-semibold transition disabled:opacity-40';
  return (
    <div className="mt-2 rounded-xl border border-risk-medium/30 bg-risk-medium/10 p-2.5 text-xs" role="status">
      <p className="text-ink">{h.message}</p>
      <p className="mt-1 text-muted">
        The first trade went through, the second didn&apos;t. The {sym} is in your wallet.{' '}
        <Link href={`/token/${h.legs.pairToken}`} className="underline">
          View {sym}
        </Link>
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void q.resumePair('finish')} className={`${btn} bg-go text-bg`}>
          {h.legs.side === 'buy' ? 'Retry buy' : `Retry: sell ${sym} for ETH`}
        </button>
        {h.legs.side === 'buy' && (
          <button type="button" disabled={busy} onClick={() => void q.resumePair('unwind')} className={`${btn} bg-white/[0.08] text-ink hover:bg-white/[0.12]`}>
            Sell {sym} for ETH
          </button>
        )}
        <button type="button" disabled={busy} onClick={q.dismissPair} className={`${btn} text-muted hover:text-ink`}>
          Keep {sym}
        </button>
      </div>
    </div>
  );
}

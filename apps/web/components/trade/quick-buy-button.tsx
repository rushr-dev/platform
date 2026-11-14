'use client';

import { useMemo, useState } from 'react';
import { parseEther } from 'viem';
import { auth } from '@/lib/auth';
import { useEthUsd } from '@/lib/profile';
import { tradingAvailable } from './flag';
import { useKeepWarm, useQuickTrade, type TradeToken } from './use-quick-trade';

/**
 * One-click quick buy for trenches rows. Uses the trenches quick-buy amount from
 * /settings unless `amountEth` is given. The buy is prebuilt while the pointer is over the button (or it
 * has focus) and refreshed every few seconds, so a click only signs and broadcasts; a cold click quotes
 * first. Sends silently if every guard passes, otherwise shows why. High-risk tokens need
 * "I understand" on the token page first.
 * Renders nothing unless trading is enabled.
 */
/**
 * `subtle`: a tinted chip for dense lists (trenches cards, two per card); `solid` is the default.
 * `amountUsd` (trenches) is converted to ETH at the live ETH price, like the token page's simple
 * trade card; otherwise `amountEth`, or the quick-buy amount from settings.
 */
export function QuickBuyButton({ token, amountEth, amountUsd, variant = 'solid' }: { token: TradeToken; amountEth?: string; amountUsd?: number; variant?: 'solid' | 'subtle' }) {
  if (!tradingAvailable()) return null;
  return <QuickBuyInner token={token} amountEth={amountEth} amountUsd={amountUsd} variant={variant} />;
}

function QuickBuyInner({ token, amountEth, amountUsd, variant }: { token: TradeToken; amountEth?: string; amountUsd?: number; variant: 'solid' | 'subtle' }) {
  const q = useQuickTrade(token);
  const [note, setNote] = useState<string | null>(null);
  const ethUsd = useEthUsd();
  // Rounded to whole dollars so small price ticks don't keep re-quoting the prebuilt trade.
  const px = ethUsd ? Math.round(ethUsd) : null;
  const eth = amountUsd != null ? (px ? (amountUsd / px).toFixed(15).replace(/\.?0+$/, '') : '0') : (amountEth ?? q.settings.quickBuy);
  const shown = amountUsd != null ? `$${amountUsd}` : eth;
  const busy = q.status.kind === 'quoting' || q.status.kind === 'sending' || q.status.kind === 'pending';
  const [hot, setHot] = useState(false);
  const wei = useMemo(() => {
    try {
      return parseEther(eth);
    } catch {
      return 0n;
    }
  }, [eth]);
  useKeepWarm(q, 'buy', wei, hot && !!q.wallet);

  const click = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // rows are links to the token page
    setNote(null);
    if (!q.session.authenticated || !q.wallet) return auth.login();
    if (amountUsd != null && !px) return setNote('Loading the ETH price. Try again in a moment.');
    if (wei <= 0n) return setNote('Invalid quick-buy amount; check /settings.');
    await q.execute({ side: 'buy', amount: wei });
  };
  const ackNeeded = q.trade?.blockers.some((b) => b.code === 'RISK_ACK_REQUIRED');
  const failedNote = q.status.kind === 'failed' ? (ackNeeded ? 'High risk: open the token page to confirm "I understand" first.' : q.status.message) : null;

  const label = q.status.kind === 'success' ? 'Bought' : q.status.kind === 'pending' ? 'Sent' : q.status.kind === 'failed' ? 'Retry' : busy ? '…' : variant === 'subtle' || amountUsd != null ? shown : `${eth} ETH`;
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={click}
        onPointerEnter={() => setHot(true)}
        onPointerLeave={() => setHot(false)}
        onFocus={() => setHot(true)}
        onBlur={() => setHot(false)}
        disabled={busy}
        title={note ?? failedNote ?? (q.status.kind === 'success' ? `Confirmed in ${(q.status.ms / 1000).toFixed(1)}s` : `Quick buy ${amountUsd != null ? `$${amountUsd} (≈ ${Number(eth).toFixed(5)} ETH)` : `${eth} ETH`} of ${token.symbol}`)}
        aria-label={`Quick buy ${amountUsd != null ? `$${amountUsd}` : `${eth} ETH`} of ${token.symbol}`}
        className={`rounded-lg px-2 py-1 font-mono text-[11px] font-semibold transition disabled:opacity-50 ${
          q.status.kind === 'success' ? 'bg-brand/20 text-brand' : q.status.kind === 'pending' ? 'bg-brand/20 text-brand' : q.status.kind === 'failed' || note ? 'bg-risk-high/20 text-risk-high' : variant === 'subtle' ? 'bg-brand/15 text-brand hover:bg-brand/25' : 'bg-go text-bg hover:brightness-110'
        }`}
      >
        ⚡ {label}
      </button>
      {q.status.kind === 'success' && (
        <a href={q.status.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="ml-1 self-center text-[10px] text-muted underline">
          tx
        </a>
      )}
    </span>
  );
}

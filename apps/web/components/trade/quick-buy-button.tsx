'use client';

import { useState } from 'react';
import { parseEther } from 'viem';
import { auth } from '@/lib/auth';
import { tradingAvailable } from './flag';
import { useQuickTrade, type TradeToken } from './use-quick-trade';

/**
 * One-click quick buy for trenches rows (Terminal places it). Uses the trenches quick-buy amount from
 * /settings unless `amountEth` is given. Quotes on click and sends silently if every guard passes;
 * otherwise shows why. High-risk tokens need "I understand" on the token page first.
 * Renders nothing unless trading is enabled.
 */
export function QuickBuyButton({ token, amountEth }: { token: TradeToken; amountEth?: string }) {
  if (!tradingAvailable()) return null;
  return <QuickBuyInner token={token} amountEth={amountEth} />;
}

function QuickBuyInner({ token, amountEth }: { token: TradeToken; amountEth?: string }) {
  const q = useQuickTrade(token);
  const [note, setNote] = useState<string | null>(null);
  const eth = amountEth ?? q.settings.quickBuy;
  const busy = q.status.kind === 'quoting' || q.status.kind === 'sending' || q.status.kind === 'pending';

  const click = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation(); // rows are links to the token page
    setNote(null);
    if (!q.session.authenticated || !q.wallet) return auth.login();
    let wei: bigint;
    try {
      wei = parseEther(eth);
    } catch {
      return setNote('Invalid quick-buy amount; check /settings.');
    }
    const t = await q.prepare('buy', wei);
    if (!t) return;
    const blocker = t.blockers.find((b) => b.code !== 'RISK_ACK_REQUIRED') ?? t.blockers[0];
    if (blocker) return setNote(blocker.code === 'RISK_ACK_REQUIRED' ? 'High risk: open the token page to confirm "I understand" first.' : blocker.message);
    await q.execute();
  };

  const label = q.status.kind === 'success' ? 'Bought' : q.status.kind === 'failed' ? 'Retry' : busy ? '…' : `${eth} ETH`;
  return (
    <span className="relative inline-flex">
      <button
        type="button"
        onClick={click}
        disabled={busy}
        title={note ?? (q.status.kind === 'failed' ? q.status.message : `Quick buy ${eth} ETH of ${token.symbol}`)}
        aria-label={`Quick buy ${eth} ETH of ${token.symbol}`}
        className={`rounded-lg px-2 py-1 font-mono text-[11px] font-semibold transition disabled:opacity-50 ${
          q.status.kind === 'success' ? 'bg-brand/20 text-brand' : q.status.kind === 'failed' || note ? 'bg-risk-high/20 text-risk-high' : 'bg-go text-bg hover:brightness-110'
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

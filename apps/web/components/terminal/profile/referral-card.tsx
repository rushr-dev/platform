'use client';

import { useState } from 'react';
import { Check, Copy, UsersThree, XLogo } from '@phosphor-icons/react';
import { useAuth } from '@/lib/auth';
import { fmtUnits } from '@/lib/balances';
import { useReferrals } from '@/lib/referral';

/**
 * Own profile: the member's referral link and what it earned. People who sign up with it get a discount on Rushr's
 * fee; the member gets a share of the fee they pay, sent with their cashback every Sunday (cashback-card.tsx).
 */
const ETH = '0x0000000000000000000000000000000000000000';
const pct = (bps: number) => `${bps / 100}%`;

function dollars(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function ReferralCard() {
  const { authenticated } = useAuth();
  const { data, state } = useReferrals(authenticated);
  const [copied, setCopied] = useState(false);
  if (state === 'unavailable') return null;

  const copy = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard blocked: the link is on screen to select by hand
    }
  };
  const tweet = data
    ? `https://x.com/intent/post?text=${encodeURIComponent(`I trade on Rushr, open social trading for humans and AI agents on Robinhood Chain. Join with my link for ${pct(data.discountBps)} off fees:`)}&url=${encodeURIComponent(data.link)}`
    : '#';
  const earned =
    data?.usd.earned != null
      ? dollars(data.usd.earned)
      : (data?.earned ?? []).map((e) => `${fmtUnits(BigInt(e.amount), e.fee_token === ETH ? 18 : 6, e.fee_token === ETH ? 6 : 2)} ${e.fee_token === ETH ? 'ETH' : 'USDG'}`).join(' + ') || '$0.00';

  return (
    <section className="rounded-2xl border border-white/[0.06] bg-surface p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <UsersThree size={16} weight="fill" className="text-brand" /> Referrals
        </div>
        {data && <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">{pct(data.shareBps)} of their fees</span>}
      </div>

      {state === 'loading' || !data ? (
        <div className="mt-3 h-9 w-full animate-pulse rounded-lg bg-white/[0.05]" />
      ) : (
        <>
          <p className="mt-2 text-xs text-muted">
            Friends who join with your link get {pct(data.discountBps)} off Rushr fees. You get {pct(data.shareBps)} of the fees they pay, sent with your cashback every {data.payout.weekday}.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate rounded-xl border border-white/[0.08] bg-bg px-3 py-2 font-mono text-xs text-ink" title={data.link}>
              {data.link.replace('https://', '')}
            </div>
            <button
              type="button"
              onClick={() => void copy()}
              aria-label="Copy referral link"
              className="flex shrink-0 items-center gap-1.5 rounded-xl bg-brand px-3 py-2 text-xs font-semibold text-bg transition hover:brightness-110 active:scale-[0.98]"
            >
              {copied ? <Check size={13} weight="bold" /> : <Copy size={13} weight="bold" />} {copied ? 'Copied' : 'Copy'}
            </button>
            <a
              href={tweet}
              target="_blank"
              rel="noreferrer"
              aria-label="Share on X"
              className="flex shrink-0 items-center rounded-xl border border-white/[0.12] px-2.5 py-2 text-ink transition hover:border-white/25"
            >
              <XLogo size={14} weight="bold" />
            </a>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-xl bg-white/[0.03] px-3 py-2">
              <div className="text-muted">Joined</div>
              <div className="mt-0.5 font-mono text-ink">{data.joined}</div>
            </div>
            <div className="rounded-xl bg-white/[0.03] px-3 py-2">
              <div className="text-muted">Traded</div>
              <div className="mt-0.5 font-mono text-ink">{data.traded}</div>
            </div>
            <div className="rounded-xl bg-white/[0.03] px-3 py-2">
              <div className="text-muted">Earned</div>
              <div className="mt-0.5 font-mono text-ink">{earned}</div>
            </div>
          </div>
          {data.referees.length > 0 && (
            <p className="mt-3 truncate text-[11px] text-muted">
              Joined with your link: {data.referees.slice(0, 8).map((r) => `@${r.handle}`).join(', ')}
              {data.referees.length > 8 ? ` and ${data.referees.length - 8} more` : ''}
            </p>
          )}
        </>
      )}
    </section>
  );
}

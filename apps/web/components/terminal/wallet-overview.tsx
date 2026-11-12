'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Address } from 'viem';
import { ArrowDown, ArrowUp, ArrowsClockwise } from '@phosphor-icons/react';
import { compact, pctSigned, usd, usdSigned } from '@/lib/format';
import type { Holding, Holdings } from '@/lib/holdings';
import { TokenAvatar } from './bits';
import { DepositPanel } from './profile/funding';
import { Modal } from './profile/modal';
import { WithdrawPanel } from './profile/withdraw';

const DUST_USD = 1;

/**
 * A standard wallet view: total balance with its 24h change, Deposit and Withdraw, then every
 * token held (ETH and USDG first, the rest by $ value) with dust behind a toggle. Rows open the
 * token page. Used by the top-bar wallet drawer and the profile's cash card.
 */
export function WalletOverview({
  wallet,
  holdings: h,
  menu,
  onNavigate,
  dense = false,
}: {
  wallet: Address | null;
  /** From useWalletHoldings(wallet), owned by the caller so a page can reuse the total. */
  holdings: Holdings;
  /** Extra header control (the profile's ⋯ menu). */
  menu?: React.ReactNode;
  /** Called when a row link is followed (the drawer closes itself). */
  onNavigate?: () => void;
  /** Drawer layout: no card chrome. */
  dense?: boolean;
}) {
  const [modal, setModal] = useState<'deposit' | 'withdraw' | null>(null);
  const [showDust, setShowDust] = useState(false);
  const dust = h.items.filter((x) => !x.cash && (x.valueUsd ?? 0) < DUST_USD);
  const rows = showDust ? h.items : h.items.filter((x) => x.cash || (x.valueUsd ?? 0) >= DUST_USD);
  const up = (h.change24hUsd ?? 0) >= 0;
  const cash = h.items.find((x) => x.symbol === 'ETH');
  const usdg = h.items.find((x) => x.symbol === 'USDG');

  return (
    <section className={dense ? '' : 'rounded-2xl border border-white/[0.06] bg-surface p-4'} aria-label="Wallet">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs text-muted">Total balance</div>
          <div className="mt-0.5 font-mono text-3xl font-semibold tracking-tight">{h.totalUsd == null ? <Skel w={120} h={32} /> : usd(h.totalUsd)}</div>
          <div className="mt-1 h-5 font-mono text-sm">
            {h.change24hUsd != null ? (
              <span className={`inline-flex items-center gap-1 ${up ? 'text-go' : 'text-risk-high'}`}>
                {up ? <ArrowUp size={12} weight="bold" /> : <ArrowDown size={12} weight="bold" />}
                {usdSigned(h.change24hUsd)}
                {h.change24hPct != null && <span>({pctSigned(h.change24hPct, 2)})</span>}
                <span className="font-sans text-xs text-muted">24h</span>
              </span>
            ) : (
              <span className="text-xs text-muted">{h.state === 'loading' || !h.totalUsd ? '' : '24h change shows once token prices carry it'}</span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" onClick={h.refresh} aria-label="Refresh balances" title="Refresh" className="rounded-lg p-1.5 text-muted hover:bg-white/[0.05] hover:text-ink">
            <ArrowsClockwise size={16} />
          </button>
          {menu}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => setModal('deposit')} disabled={!wallet} className="rounded-xl bg-brand py-2.5 text-sm font-semibold text-bg hover:brightness-110 disabled:opacity-40">
          Deposit
        </button>
        <button
          type="button"
          onClick={() => setModal('withdraw')}
          disabled={!wallet}
          className="rounded-xl border border-white/[0.1] py-2.5 text-sm font-semibold hover:border-white/25 disabled:opacity-40"
        >
          Withdraw
        </button>
      </div>

      <div className="mt-4 flex items-center justify-between text-[11px] text-muted">
        <span>Tokens</span>
        {dust.length > 0 && (
          <label className="flex cursor-pointer items-center gap-1.5">
            <input type="checkbox" checked={showDust} onChange={(e) => setShowDust(e.target.checked)} className="accent-[#36d42a]" />
            Show dust ({dust.length})
          </label>
        )}
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {h.items.length === 0
          ? Array.from({ length: 3 }, (_, i) => (
              <li key={i} className="flex items-center gap-3 px-2 py-2">
                <Skel w={32} h={32} round />
                <Skel w={90} h={14} />
              </li>
            ))
          : rows.map((x) => <Row key={x.address ?? 'eth'} x={x} onNavigate={onNavigate} />)}
      </ul>
      {h.state === 'ready' && rows.length <= 2 && !dust.length && (cash?.raw ?? 0n) === 0n && (usdg?.raw ?? 0n) === 0n && (
        <p className="mt-2 rounded-xl bg-white/[0.03] px-3 py-2.5 text-xs text-muted">Your wallet is empty. Deposit ETH or USDG on Robinhood Chain to start trading.</p>
      )}

      {modal === 'deposit' && (
        <Modal title="Deposit" onClose={() => setModal(null)} wide>
          <DepositPanel address={wallet} />
        </Modal>
      )}
      {modal === 'withdraw' && wallet && (
        <Modal title="Withdraw" onClose={() => setModal(null)}>
          <WithdrawPanel
            from={wallet}
            balances={cash && usdg ? { eth: cash.raw, usdg: usdg.raw } : null}
            onDone={h.refresh}
          />
        </Modal>
      )}
    </section>
  );
}

function amountLabel(x: Holding) {
  if (x.amount === 0) return '0';
  if (x.symbol === 'ETH') return x.amount < 0.0001 ? '<0.0001' : x.amount.toFixed(x.amount >= 10 ? 3 : 5).replace(/\.?0+$/, '');
  if (x.symbol === 'USDG') return x.amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return compact(x.amount);
}

function Row({ x, onNavigate }: { x: Holding; onNavigate?: () => void }) {
  const change = x.change24hPct;
  const body = (
    <>
      <CoinIcon x={x} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{x.symbol}</span>
        <span className="block truncate text-[11px] text-muted">{x.name}</span>
      </span>
      <span className="shrink-0 text-right font-mono tabular-nums">
        <span className="block text-sm">{x.valueUsd == null ? '—' : usd(x.valueUsd)}</span>
        <span className="block text-[11px] text-muted">
          {amountLabel(x)}
          {change != null && !(x.symbol === 'USDG') && (
            <span className={`ml-1.5 ${change >= 0 ? 'text-go' : 'text-risk-high'}`}>{pctSigned(change, 1)}</span>
          )}
          {change == null && <span className="ml-1.5 text-muted/60" title="24h change isn't available for this token yet">—</span>}
        </span>
      </span>
    </>
  );
  const cls = 'flex items-center gap-3 rounded-xl px-2 py-2';
  // ETH has no token page; everything else (USDG included) opens its token page.
  return (
    <li>
      {x.address ? (
        <Link href={`/token/${x.address}`} onClick={onNavigate} className={`${cls} hover:bg-white/[0.03]`}>
          {body}
        </Link>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}

function CoinIcon({ x }: { x: Holding }) {
  if (x.symbol === 'ETH')
    return (
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#627eea]" aria-hidden>
        <svg viewBox="0 0 24 24" className="size-4" fill="#fff">
          <path d="M12 2 5.5 12.3 12 16l6.5-3.7z" opacity=".9" />
          <path d="m12 17.3-6.5-3.8L12 22l6.5-8.5z" />
        </svg>
      </span>
    );
  if (x.symbol === 'USDG' && !x.imageUrl)
    return (
      <span className="grid size-8 shrink-0 place-items-center rounded-full bg-[#0e7a4f] font-mono text-sm font-bold text-white" aria-hidden>
        $
      </span>
    );
  return <TokenAvatar t={{ address: x.address ?? '0x', symbol: x.symbol, launchpad: null, image_url: x.imageUrl }} size={32} />;
}

function Skel({ w, h, round = false }: { w: number; h: number; round?: boolean }) {
  return <span className={`inline-block animate-pulse bg-white/[0.06] align-middle ${round ? 'rounded-full' : 'rounded'}`} style={{ width: w, height: h }} />;
}

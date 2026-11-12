'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowSquareOut, Check, Copy, GearSix, Key, Warning, X } from '@phosphor-icons/react';
import { auth, useAuth } from '@/lib/auth';
import { fmtUnits, useBalances } from '@/lib/balances';
import { EXPLORER } from '@/lib/format';

/**
 * The user's Rushr wallet: balances, how to deposit, key export and a link to trading settings.
 * Opens as a drawer from the account menu. Rendered into document.body: the top bar has a
 * backdrop-filter, which makes it the containing block for `position: fixed` children, so a drawer
 * rendered inside it would be clipped to the bar's 56px height.
 */
export function WalletPanel({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const address = user?.wallet ?? null;
  const { balances, error, refresh } = useBalances(address);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex justify-end" role="dialog" aria-modal="true" aria-label="Your wallet">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" />
      <div className="relative flex h-full w-full max-w-sm flex-col overflow-y-auto border-l border-white/[0.08] bg-surface p-5 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Your wallet</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-white/[0.05] hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <section className="mt-5 grid grid-cols-2 gap-2">
          <Balance label="ETH" value={balances ? fmtUnits(balances.eth, 18, 5) : null} error={error} />
          <Balance label="USDG" value={balances ? fmtUnits(balances.usdg, 6, 2) : null} error={error} />
        </section>
        <button type="button" onClick={refresh} className="mt-1.5 self-end text-[11px] text-muted hover:text-ink">
          Refresh
        </button>

        <section className="mt-4 rounded-2xl border border-white/[0.06] bg-bg p-4">
          <h3 className="text-sm font-semibold">Deposit</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Send <span className="text-ink">ETH or USDG on Robinhood Chain</span> (chain ID 4663) to this address. Funds sent on another network
            won&apos;t arrive here.
          </p>
          {address ? (
            <>
              <div className="mt-3 break-all rounded-xl border border-white/[0.06] bg-surface-2 px-3 py-2.5 font-mono text-[13px] leading-relaxed">{address}</div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard?.writeText(address).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    })
                  }
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-ink py-2 text-sm font-semibold text-bg hover:bg-white"
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy address'}
                </button>
                <a
                  href={`${EXPLORER}/address/${address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 rounded-xl border border-white/[0.08] px-3 py-2 text-sm text-muted hover:text-ink"
                >
                  Explorer <ArrowSquareOut size={13} />
                </a>
              </div>
            </>
          ) : (
            <p className="mt-3 text-sm text-muted">Creating your wallet…</p>
          )}
        </section>

        <section className="mt-4 rounded-2xl border border-white/[0.06] bg-bg p-4">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Key size={15} /> Export private key
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Your wallet is yours: export the key to use it in MetaMask or any other wallet. Privy shows it in a secure window Rushr can&apos;t
            read. Never share it with anyone.
          </p>
          <button
            type="button"
            disabled={!address || exporting}
            onClick={() => {
              setExporting(true);
              setExportError(null);
              auth
                .exportWallet()
                .catch((e: Error) => setExportError(e.message || 'Export failed'))
                .finally(() => setExporting(false));
            }}
            className="mt-3 w-full rounded-xl border border-risk-medium/30 py-2 text-sm font-semibold text-risk-medium hover:bg-risk-medium/10 disabled:opacity-50"
          >
            {exporting ? 'Opening…' : 'Export key'}
          </button>
          {exportError && (
            <p className="mt-2 flex items-center gap-1 text-xs text-risk-high">
              <Warning size={13} /> {exportError}
            </p>
          )}
        </section>

        <Link
          href="/settings"
          onClick={onClose}
          className="mt-4 flex items-center justify-between rounded-2xl border border-white/[0.06] bg-bg px-4 py-3 text-sm hover:border-white/15"
        >
          <span className="flex items-center gap-2">
            <GearSix size={16} /> Trading settings
          </span>
          <span className="text-xs text-muted">Presets, slippage, caps</span>
        </Link>
      </div>
    </div>,
    document.body,
  );
}

function Balance({ label, value, error }: { label: string; value: string | null; error: boolean }) {
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-bg px-4 py-3">
      <div className="text-[11px] text-muted">{label}</div>
      <div className="mt-0.5 font-mono text-lg font-semibold">{value ?? (error ? '—' : <span className="inline-block h-5 w-16 animate-pulse rounded bg-white/[0.06] align-middle" />)}</div>
    </div>
  );
}

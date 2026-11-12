'use client';

import { useState } from 'react';
import { ArrowSquareOut, Bank, Check, Copy, CreditCard, Shuffle, Warning } from '@phosphor-icons/react';
import { USDG } from '@/lib/balances';
import { EXPLORER } from '@/lib/format';

/**
 * Own-profile funding (the Deposit modal). Only options verified to reach Robinhood Chain (4663) are shown
 * (research 2026-11-12: Robinhood app transfers, Relay and Across bridges, MoonPay for USDG, the
 * canonical Arbitrum bridge). Links are exact official URLs: lookalike "Robinhood bridge" phishing
 * sites exist.
 */
const ETH = '0x0000000000000000000000000000000000000000';
const relayUrl = (to: string, token: string) =>
  `https://relay.link/bridge/robinhood?fromChainId=8453&toAddress=${to}&toCurrency=${token}`;
const ACROSS_URL = 'https://across.to/?to=robinhood';
const CANONICAL_URL = 'https://portal.arbitrum.io/bridge?sourceChain=ethereum&destinationChain=robinhood-chain';
const MOONPAY_URL = 'https://www.moonpay.com/buy';

/** Deposit modal body: the address, the chain warning, and every verified way to fund it. */
export function DepositPanel({ address }: { address: `0x${string}` | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="text-[11px] text-muted">Your Rushr wallet on Robinhood Chain</div>
      {address ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 break-all rounded-xl border border-white/[0.06] bg-bg px-3 py-2 font-mono text-[13px]">{address}</span>
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard?.writeText(address).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
            className="flex items-center gap-1.5 rounded-xl bg-ink px-3 py-2 text-sm font-semibold text-bg hover:bg-white"
          >
            {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy'}
          </button>
          <a href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer" className="rounded-xl border border-white/[0.08] p-2 text-muted hover:text-ink" title="Open in explorer">
            <ArrowSquareOut size={16} />
          </a>
        </div>
      ) : (
        <p className="mt-1.5 text-sm text-muted">Creating your wallet…</p>
      )}
      <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-risk-medium">
        <Warning size={13} className="mt-px shrink-0" weight="fill" />
        Only send ETH or USDG on Robinhood Chain (chain ID 4663). Funds sent on another network won&apos;t arrive.
      </p>

      <h3 className="mt-5 text-sm font-semibold">Ways to add funds</h3>
      <div className="mt-2 space-y-2">
        <Option
          icon={Bank}
          title="From Robinhood"
          badge="Easiest"
          body={
            <>
              In the Robinhood app, buy ETH or USDG, tap <span className="text-ink">Send</span>, choose the{' '}
              <span className="text-ink">Robinhood Chain</span> network and paste your address above. Not available in New York.
            </>
          }
        />
        <Option
          icon={Shuffle}
          title="Bridge from Base, Arbitrum or Ethereum"
          body="Seconds, small fee. Your address is filled in on Relay; double-check it before you confirm."
          actions={
            address && (
              <>
                <ExtLink href={relayUrl(address, ETH)}>Bridge ETH (Relay)</ExtLink>
                <ExtLink href={relayUrl(address, USDG)}>Bridge USDG (Relay)</ExtLink>
                <ExtLink href={ACROSS_URL} subtle>
                  Across
                </ExtLink>
              </>
            )
          }
        />
        <Option
          icon={CreditCard}
          title="Buy with card"
          body="MoonPay sells USDG on Robinhood Chain (not in New York or Canada). Choose Robinhood Chain and paste your address. For ETH, buy on Base, then bridge with Relay."
          actions={<ExtLink href={MOONPAY_URL}>Open MoonPay</ExtLink>}
        />
        <details className="group rounded-xl border border-white/[0.06] bg-bg px-3 py-2.5 text-xs text-muted">
          <summary className="cursor-pointer select-none text-ink/80 marker:text-muted">Advanced: official bridge from Ethereum</summary>
          <p className="mt-2 leading-relaxed">
            Arbitrum&apos;s canonical bridge: about 10 minutes in, 7 days to withdraw, and you pay Ethereum gas. It sends to the wallet you connect
            there, so use it only with a wallet you control and then send on to your Rushr address.
          </p>
          <div className="mt-2">
            <ExtLink href={CANONICAL_URL} subtle>
              Arbitrum bridge
            </ExtLink>
          </div>
        </details>
      </div>
    </div>
  );
}

function Option({ icon: Icon, title, badge, body, actions }: { icon: typeof Bank; title: string; badge?: string; body: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-white/[0.06] bg-bg p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon size={16} className="text-brand" />
        {title}
        {badge && <span className="rounded-md bg-brand/15 px-1.5 py-0.5 text-[10px] font-semibold text-brand">{badge}</span>}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted">{body}</p>
      {actions && <div className="mt-2 flex flex-wrap gap-1.5">{actions}</div>}
    </div>
  );
}

function ExtLink({ href, children, subtle = false }: { href: string; children: React.ReactNode; subtle?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium ${subtle ? 'border border-white/[0.08] text-muted hover:text-ink' : 'bg-white/[0.08] text-ink hover:bg-white/[0.12]'}`}
    >
      {children} <ArrowSquareOut size={12} />
    </a>
  );
}

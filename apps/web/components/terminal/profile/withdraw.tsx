'use client';

import { useState } from 'react';
import { encodeFunctionData, erc20Abi, formatUnits, getAddress, isAddress, parseUnits } from 'viem';
import { ArrowSquareOut, CheckCircle, Warning } from '@phosphor-icons/react';
import { auth } from '@/lib/auth';
import { publicClient, USDG, type Balances } from '@/lib/balances';
import { EXPLORER, short } from '@/lib/format';

type Asset = 'ETH' | 'USDG';
const DECIMALS: Record<Asset, number> = { ETH: 18, USDG: 6 };
/** Gas kept back on "Max" for an ETH send: a plain transfer is 21k gas; keep room for a busy block. */
const GAS_RESERVE_UNITS = 60_000n;

type Step = { kind: 'form' } | { kind: 'review' } | { kind: 'sending' } | { kind: 'done'; hash: `0x${string}` } | { kind: 'failed'; message: string };

/**
 * Send ETH or USDG from the Rushr wallet to any address on Robinhood Chain. The user reviews, then
 * their own Privy embedded wallet signs (Rushr never holds the key); we wait for the receipt.
 */
export function WithdrawPanel({ from, balances, onDone }: { from: `0x${string}`; balances: Balances | null; onDone: () => void }) {
  const [asset, setAsset] = useState<Asset>('ETH');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [error, setError] = useState<string | null>(null);

  const bal = balances ? (asset === 'ETH' ? balances.eth : balances.usdg) : null;
  let wei: bigint | null = null;
  try {
    wei = amount ? parseUnits(amount, DECIMALS[asset]) : null;
  } catch {
    wei = null;
  }
  const toOk = isAddress(to.trim(), { strict: false });
  const self = toOk && getAddress(to.trim()) === getAddress(from);

  const max = async () => {
    if (bal == null) return;
    if (asset === 'USDG') return setAmount(formatUnits(bal, 6));
    const gasPrice = await publicClient().getGasPrice().catch(() => 100_000_000n);
    const left = bal - gasPrice * GAS_RESERVE_UNITS;
    setAmount(left > 0n ? formatUnits(left, 18) : '0');
  };

  const review = () => {
    setError(null);
    if (!toOk) return setError('Enter a valid 0x address.');
    if (self) return setError('That is your own Rushr wallet.');
    if (!wei || wei <= 0n) return setError('Enter an amount.');
    if (bal != null && wei > bal) return setError(`More than your ${asset} balance.`);
    setStep({ kind: 'review' });
  };

  const send = async () => {
    if (!wei) return;
    setStep({ kind: 'sending' });
    try {
      const recipient = getAddress(to.trim());
      const hash =
        asset === 'ETH'
          ? await auth.sendTransaction({ to: recipient, value: wei })
          : await auth.sendTransaction({ to: USDG, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [recipient, wei] }), value: 0n });
      const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== 'success') throw new Error('The transaction reverted on-chain.');
      setStep({ kind: 'done', hash });
      onDone();
    } catch (e) {
      const msg = (e as Error).message || 'Sending failed.';
      setStep({ kind: 'failed', message: /reject|denied|cancel/i.test(msg) ? 'Cancelled.' : msg.slice(0, 200) });
    }
  };

  if (step.kind === 'done')
    return (
      <div className="text-center">
        <CheckCircle size={40} weight="fill" className="mx-auto text-brand" />
        <p className="mt-2 font-semibold">Sent</p>
        <p className="mt-1 text-sm text-muted">
          {amount} {asset} to {short(to.trim())}
        </p>
        <a href={`${EXPLORER}/tx/${step.hash}`} target="_blank" rel="noreferrer" className="mt-3 inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
          View transaction <ArrowSquareOut size={12} />
        </a>
      </div>
    );

  if (step.kind === 'review' || step.kind === 'sending' || step.kind === 'failed')
    return (
      <div>
        <dl className="space-y-2 rounded-xl border border-white/[0.06] bg-bg p-4 text-sm">
          <Row k="Send" v={`${amount} ${asset}`} />
          <Row k="To" v={<span className="break-all font-mono text-xs">{getAddress(to.trim())}</span>} />
          <Row k="Network" v="Robinhood Chain (4663)" />
        </dl>
        <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-risk-medium">
          <Warning size={13} weight="fill" className="mt-px shrink-0" />
          Transfers can&apos;t be undone. Make sure the address can receive on Robinhood Chain (an exchange deposit address must support this network).
        </p>
        {step.kind === 'failed' && <p className="mt-2 text-xs text-risk-high">{step.message}</p>}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" disabled={step.kind === 'sending'} onClick={() => setStep({ kind: 'form' })} className="rounded-xl border border-white/[0.08] py-2.5 text-sm text-muted hover:text-ink disabled:opacity-40">
            Back
          </button>
          <button type="button" disabled={step.kind === 'sending'} onClick={() => void send()} className="rounded-xl bg-ink py-2.5 text-sm font-semibold text-bg hover:bg-white disabled:opacity-60">
            {step.kind === 'sending' ? 'Sending…' : 'Confirm & send'}
          </button>
        </div>
      </div>
    );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        review();
      }}
    >
      <div className="grid grid-cols-2 rounded-xl bg-white/[0.04] p-1 text-sm font-semibold">
        {(['ETH', 'USDG'] as const).map((a) => (
          <button key={a} type="button" onClick={() => setAsset(a)} className={`rounded-lg py-1.5 ${asset === a ? 'bg-white/[0.1] text-ink' : 'text-muted'}`}>
            {a}
          </button>
        ))}
      </div>
      <label className="mt-4 block">
        <span className="text-xs text-muted">To address (Robinhood Chain)</span>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value.trim())}
          placeholder="0x…"
          spellCheck={false}
          className="mt-1 w-full rounded-xl border border-white/[0.08] bg-bg px-3 py-2.5 font-mono text-sm outline-none focus:border-white/25"
        />
      </label>
      <label className="mt-3 block">
        <span className="flex justify-between text-xs text-muted">
          <span>Amount</span>
          <span>
            Balance {bal == null ? '…' : `${Number(formatUnits(bal, DECIMALS[asset])).toLocaleString('en-US', { maximumFractionDigits: asset === 'ETH' ? 6 : 2 })} ${asset}`}
          </span>
        </span>
        <div className="mt-1 flex items-center rounded-xl border border-white/[0.08] bg-bg px-3 py-2 focus-within:border-white/25">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
            inputMode="decimal"
            placeholder="0.0"
            className="w-full bg-transparent font-mono text-lg outline-none"
          />
          <button type="button" onClick={() => void max()} className="rounded-lg bg-white/[0.06] px-2 py-1 text-xs text-muted hover:text-ink">
            Max
          </button>
        </div>
      </label>
      {error && <p className="mt-2 text-xs text-risk-high">{error}</p>}
      <button type="submit" className="mt-4 w-full rounded-xl bg-ink py-2.5 text-sm font-semibold text-bg hover:bg-white">
        Review
      </button>
    </form>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="shrink-0 text-muted">{k}</dt>
      <dd className="text-right">{v}</dd>
    </div>
  );
}

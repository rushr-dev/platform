'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowSquareOut, Check, Copy, GearSix, SignOut, User, Wallet } from '@phosphor-icons/react';
import { auth, displayName, useAuth } from '@/lib/auth';
import { fmtUnits, useBalances } from '@/lib/balances';
import { useMe } from '@/lib/members';
import { EXPLORER, short } from '@/lib/format';
import { GeneratedAvatar } from '../avatar';
import { iconSrc } from '../bits';
import { WalletPanel } from './wallet-panel';

/** Top-bar sign-in button, and the account menu once signed in. */
export function AccountMenu() {
  const { enabled, authenticated, user } = useAuth();
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Balance only while the menu is open (the wallet drawer reads its own).
  const { balances } = useBalances(open ? (user?.wallet ?? null) : null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!enabled) {
    return (
      <button type="button" disabled title="Sign-in opens soon" className="flex items-center gap-2 rounded-xl bg-ink px-3.5 py-2 text-sm font-semibold text-bg opacity-90">
        <Wallet size={16} weight="bold" />
        <span className="hidden sm:inline">Sign in</span>
      </button>
    );
  }

  if (!authenticated || !user) {
    return (
      <button
        type="button"
        onClick={() => auth.login()}
        className="flex items-center gap-2 rounded-xl bg-ink px-3.5 py-2 text-sm font-semibold text-bg transition hover:bg-white"
      >
        <Wallet size={16} weight="bold" />
        <span className="hidden sm:inline">Sign in</span>
      </button>
    );
  }

  const name = me?.status === 'registered' ? `@${me.member.handle}` : displayName(user);
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-xl border border-white/[0.08] bg-surface py-1 pl-1 pr-3 text-sm transition hover:border-white/20"
      >
        <UserAvatar user={user} size={28} />
        <span className="hidden max-w-[12ch] truncate font-medium sm:inline">{name}</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+8px)] z-50 w-72 overflow-hidden rounded-2xl border border-white/[0.08] bg-surface-2 shadow-2xl shadow-black/60">
          <div className="flex items-center gap-3 border-b border-white/[0.06] p-4">
            <UserAvatar user={user} size={40} />
            <div className="min-w-0">
              <div className="truncate font-semibold">{name}</div>
              {user.email && name !== user.email.split('@')[0] && <div className="truncate text-xs text-muted">{user.email}</div>}
            </div>
          </div>
          <WalletRow label="Rushr wallet" address={user.wallet} pending={!user.wallet} />
          <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2.5 text-sm">
            <span className="text-muted">Balance</span>
            <span className="font-mono">{balances ? `${fmtUnits(balances.eth, 18, 4)} ETH` : '…'}</span>
          </div>
          {user.externalWallet && <WalletRow label="Signed in with" address={user.externalWallet} />}
          <div className="p-1.5">
            <Link
              href="/me"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm font-medium text-ink hover:bg-white/[0.04]"
            >
              <User size={15} /> Profile &amp; wallet
            </Link>
            <MenuButton
              onClick={() => {
                setOpen(false);
                setWalletOpen(true);
              }}
            >
              <Wallet size={15} /> Wallet &amp; deposit
            </MenuButton>
            <Link
              href="/settings"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-muted hover:bg-white/[0.04] hover:text-ink"
            >
              <GearSix size={15} /> Trading settings
            </Link>
          </div>
          <div className="border-t border-white/[0.06] p-1.5">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                void auth.logout();
              }}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-muted hover:bg-white/[0.04] hover:text-ink"
            >
              <SignOut size={15} /> Sign out
            </button>
          </div>
        </div>
      )}
      {walletOpen && <WalletPanel onClose={() => setWalletOpen(false)} />}
    </div>
  );
}

function MenuButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-muted hover:bg-white/[0.04] hover:text-ink"
    >
      {children}
    </button>
  );
}

function WalletRow({ label, address, pending = false }: { label: string; address: `0x${string}` | null; pending?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="border-b border-white/[0.06] px-4 py-3">
      <div className="text-[11px] text-muted">{label}</div>
      {pending || !address ? (
        <div className="mt-1 text-sm text-muted">Creating your wallet…</div>
      ) : (
        <div className="mt-1 flex items-center gap-2">
          <span className="font-mono text-sm">{short(address, 6, 6)}</span>
          <button
            type="button"
            title="Copy address"
            onClick={() =>
              void navigator.clipboard?.writeText(address).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              })
            }
            className="text-muted hover:text-ink"
          >
            {copied ? <Check size={14} className="text-brand" /> : <Copy size={14} />}
          </button>
          <a href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer" title="Open in explorer" className="text-muted hover:text-ink">
            <ArrowSquareOut size={14} />
          </a>
        </div>
      )}
    </div>
  );
}

/** X profile picture when there is one, else the generated avatar from the wallet (or user id). */
export function UserAvatar({ user, size }: { user: NonNullable<ReturnType<typeof useAuth>['user']>; size: number }) {
  const [failed, setFailed] = useState(false);
  const seed = user.wallet ?? user.externalWallet ?? `0x${[...user.id].map((c) => c.charCodeAt(0).toString(16)).join('').slice(0, 40).padEnd(40, '0')}`;
  const pic = user.twitter?.avatar;
  return (
    <span className="relative block shrink-0 overflow-hidden rounded-full" style={{ width: size, height: size }}>
      <GeneratedAvatar address={seed} symbol={displayName(user).replace(/^@/, '')} size={size} />
      {pic && !failed && (
        <img src={iconSrc(pic)} alt="" width={size} height={size} onError={() => setFailed(true)} className="absolute inset-0 size-full rounded-full object-cover" />
      )}
    </span>
  );
}

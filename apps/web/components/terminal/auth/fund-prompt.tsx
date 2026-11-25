'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle, CircleNotch } from '@phosphor-icons/react';
import { useAuth } from '@/lib/auth';
import { fmtUnits, readBalances, type Balances } from '@/lib/balances';
import { useMe } from '@/lib/members';
import { Modal } from '../profile/modal';
import { DepositPanel } from '../profile/funding';

/**
 * The step after sign-up: fund the wallet, then make a first trade. Opens right after someone joins
 * (the `rushr:registered` event from onboarding.tsx), and on later visits while the member's wallet is
 * still empty: at most once a day and REMIND_MAX times in all, so it never turns into nagging. While open
 * it watches the wallet and switches to "You're funded" as soon as a deposit lands.
 */

export const REGISTERED_EVENT = 'rushr:registered';
const KEY = 'rushr.fund-prompt.v1';
const REMIND_MAX = 3;
const REMIND_EVERY_MS = 24 * 3600 * 1000;
const POLL_MS = 5_000;
/** After a page load, wait before checking the balance (the terminal comes first). */
const CHECK_AFTER_MS = 2_500;

interface Seen {
  count: number;
  at: number;
}

function readSeen(): Seen {
  try {
    return { count: 0, at: 0, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Seen>) };
  } catch {
    return { count: REMIND_MAX, at: Date.now() };
  }
}

function markShown() {
  try {
    const s = readSeen();
    localStorage.setItem(KEY, JSON.stringify({ count: s.count + 1, at: Date.now() }));
  } catch {
    // ignore
  }
}

const empty = (b: Balances) => b.eth === 0n && b.usdg === 0n;

export function FundPrompt() {
  const { user } = useAuth();
  const me = useMe();
  const wallet = user?.wallet ?? null;
  const registered = me?.status === 'registered';
  const [open, setOpen] = useState(false);
  const [balances, setBalances] = useState<Balances | null>(null);
  const router = useRouter();

  // Right after sign-up.
  useEffect(() => {
    const onJoin = () => {
      markShown();
      setOpen(true);
    };
    window.addEventListener(REGISTERED_EVENT, onJoin);
    return () => window.removeEventListener(REGISTERED_EVENT, onJoin);
  }, []);

  // Later visits: a gentle reminder while the wallet is still empty.
  useEffect(() => {
    if (!registered || !wallet) return;
    const s = readSeen();
    if (s.count >= REMIND_MAX || Date.now() - s.at < REMIND_EVERY_MS) return;
    let live = true;
    const t = window.setTimeout(() => {
      void readBalances(wallet)
        .then((b) => {
          if (!live || !empty(b)) return;
          markShown();
          setBalances(b);
          setOpen(true);
        })
        .catch(() => {});
    }, CHECK_AFTER_MS);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [registered, wallet]);

  // While open: watch for the deposit.
  useEffect(() => {
    if (!open || !wallet) return;
    let live = true;
    const run = () =>
      readBalances(wallet)
        .then((b) => live && setBalances(b))
        .catch(() => {});
    void run();
    const id = window.setInterval(run, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [open, wallet]);

  if (!open) return null;
  const funded = balances != null && !empty(balances);
  const close = () => setOpen(false);

  return (
    <Modal title={funded ? "You're funded" : 'Fund your wallet'} onClose={close} wide>
      {funded ? (
        <div>
          <div className="flex items-center gap-3 rounded-xl bg-brand/10 px-4 py-3">
            <CheckCircle size={26} weight="fill" className="shrink-0 text-brand" />
            <div className="text-sm">
              <div className="font-semibold">Deposit received</div>
              <div className="text-muted">
                {[balances.eth > 0n && `${fmtUnits(balances.eth, 18, 5)} ETH`, balances.usdg > 0n && `${fmtUnits(balances.usdg, 6, 2)} USDG`].filter(Boolean).join(' · ')}
              </div>
            </div>
          </div>
          <h3 className="mt-5 text-sm font-semibold">Make your first trade</h3>
          <ul className="mt-2 space-y-1.5 text-sm text-muted">
            <li>Open any token and check its safety verdict before you buy.</li>
            <li>Start small. New tokens on Robinhood Chain are extremely risky.</li>
            <li>Post a call when you buy: it goes on your record and the leaderboard.</li>
            <li>30% of every Rushr fee you pay comes back to your wallet as cashback, paid every Sunday.</li>
          </ul>
          <button
            type="button"
            onClick={() => {
              close();
              router.push('/trenches');
            }}
            className="mt-5 w-full rounded-xl bg-brand py-3 text-sm font-semibold text-bg transition hover:brightness-110 active:scale-[0.98]"
          >
            Find a token
          </button>
        </div>
      ) : (
        <div>
          <p className="mb-4 text-sm text-muted">
            Your Rushr wallet is ready. Add ETH or USDG on Robinhood Chain and you can trade. You can export its key from your profile at any time.
          </p>
          <DepositPanel address={wallet} />
          <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
            <span className="flex items-center gap-2 text-xs text-muted">
              <CircleNotch size={14} className="animate-spin" /> Waiting for your deposit…
            </span>
            <button type="button" onClick={close} className="text-xs text-muted hover:text-ink">
              I&apos;ll do it later
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

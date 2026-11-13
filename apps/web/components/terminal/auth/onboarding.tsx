'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { CheckCircle, Warning, XLogo } from '@phosphor-icons/react';
import { auth, useAuth, type AuthUser } from '@/lib/auth';
import { captureInviteFromUrl, clearInvite, INVITE_RE, storedInvite } from '@/lib/invite';
import { checkInvite, createMe, errorText, getMe, inviteStatusText, setMe, useMe, type InviteStatus } from '@/lib/members';
import { UserAvatar } from './account-menu';

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const X_URL = 'https://x.com/rushrtrade';
/** Shown when every seat of the shared beta code is taken (API: status 'full', error invite_full). */
const FULL_TEXT = 'All beta seats are taken. Follow @rushrtrade for the next drop.';

/** A starting handle from the email's local part (sign-in is email or wallet). */
function suggestHandle(u: AuthUser | null): string {
  const raw = u?.email?.split('@')[0] ?? '';
  const s = raw.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
  return s.length >= 3 ? s : '';
}

/** "By signing up you agree to …": the legal pages from the landing. */
export function LegalLine({ className = '' }: { className?: string }) {
  return (
    <p className={`text-[11px] leading-relaxed text-muted ${className}`}>
      By signing up you agree to the{' '}
      <Link href="/terms" target="_blank" className="text-ink/80 underline decoration-white/20 underline-offset-2 hover:text-ink">
        Terms
      </Link>
      ,{' '}
      <Link href="/risk" target="_blank" className="text-ink/80 underline decoration-white/20 underline-offset-2 hover:text-ink">
        Risk disclosure
      </Link>{' '}
      and{' '}
      <Link href="/privacy" target="_blank" className="text-ink/80 underline decoration-white/20 underline-offset-2 hover:text-ink">
        Privacy policy
      </Link>
      .
    </p>
  );
}

/**
 * Keeps the invite code from the URL, loads the signed-in user's Rushr member, and asks new users
 * to finish sign-up (handle + invite) before they use the terminal as a member.
 */
export function MemberGate() {
  const { ready, authenticated, user } = useAuth();
  const me = useMe();
  const checked = useRef<string | null>(null);

  useEffect(() => captureInviteFromUrl(), []);

  useEffect(() => {
    // Until the SDK has answered, keep whatever member the page painted from the session hint.
    if (!ready) return;
    if (!authenticated || !user) {
      checked.current = null;
      setMe(null);
      return;
    }
    if (checked.current === user.id) return;
    checked.current = user.id;
    void getMe().then(setMe);
  }, [ready, authenticated, user]);

  if (!authenticated || !user || me?.status !== 'unregistered') return null;
  return <Onboarding user={user} invitesRequired={me.invitesRequired} />;
}

function Onboarding({ user, invitesRequired }: { user: AuthUser; invitesRequired: boolean }) {
  const [handle, setHandle] = useState(() => suggestHandle(user));
  const [invite, setInvite] = useState(() => storedInvite() ?? '');
  const [inviteStatus, setInviteStatus] = useState<InviteStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);

  // Check the code as it's typed (debounced); the API only claims it on sign-up.
  useEffect(() => {
    setInviteStatus(null);
    setFull(false);
    if (!INVITE_RE.test(invite)) return;
    const t = setTimeout(
      () =>
        void checkInvite(invite).then((st) => {
          setInviteStatus(st);
          // `full` is newer than lib/members' InviteStatus union: compare as a string.
          setFull((st as string | null) === 'full');
        }),
      350,
    );
    return () => clearTimeout(t);
  }, [invite]);

  const handleOk = HANDLE_RE.test(handle);
  const inviteOk = !invitesRequired || INVITE_RE.test(invite);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const res = await createMe({ handle, inviteCode: invite || null });
    setBusy(false);
    if (!res.ok) {
      if (res.error.code === 'invite_full') {
        setFull(true);
        return setError(null);
      }
      return setError(errorText(res.error));
    }
    clearInvite();
    setMe({ status: 'registered', member: res.member });
  };

  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/70 p-4 backdrop-blur-[2px]" role="dialog" aria-modal="true" aria-label="Finish signing up">
      <form
        className="w-full max-w-sm rounded-2xl border border-white/[0.08] bg-surface p-6 shadow-2xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (handleOk && inviteOk && !busy) void submit();
        }}
      >
        <div className="flex items-center gap-3">
          <UserAvatar user={user} size={44} />
          <div>
            <h2 className="text-lg font-semibold">Welcome to Rushr</h2>
            <p className="text-xs text-muted">Pick your handle to finish signing up.</p>
          </div>
        </div>

        <label className="mt-5 block">
          <span className="text-xs text-muted">Handle</span>
          <div className="mt-1 flex items-center rounded-xl border border-white/[0.08] bg-bg px-3 py-2.5 focus-within:border-white/25">
            <span className="text-muted">@</span>
            <input
              autoFocus
              value={handle}
              onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20))}
              placeholder="yourname"
              className="ml-0.5 w-full bg-transparent outline-none"
              aria-describedby="handle-hint"
            />
          </div>
          <span id="handle-hint" className={`mt-1 block text-[11px] ${handle && !handleOk ? 'text-risk-medium' : 'text-muted'}`}>
            3–20 characters: letters, numbers and _. Shown on your trades and calls.
          </span>
        </label>

        <label className="mt-4 block">
          <span className="text-xs text-muted">Invite code{invitesRequired ? '' : ' (optional)'}</span>
          <input
            value={invite}
            onChange={(e) => setInvite(e.target.value.replace(/[^A-Za-z0-9-]/g, '').slice(0, 32))}
            placeholder="RUSHR-XXXXXXXX"
            className="mt-1 w-full rounded-xl border border-white/[0.08] bg-bg px-3 py-2.5 font-mono text-sm uppercase outline-none focus:border-white/25"
          />
          {inviteStatus && !full && (
            <span className={`mt-1 flex items-center gap-1 text-[11px] ${inviteStatus === 'valid' ? 'text-brand' : 'text-risk-high'}`}>
              {inviteStatus === 'valid' ? <CheckCircle size={12} weight="fill" /> : <Warning size={12} weight="fill" />}
              {inviteStatusText(inviteStatus)}
            </span>
          )}
        </label>

        {full && (
          <div role="alert" className="mt-4 rounded-xl border border-white/[0.08] bg-bg px-3 py-3 text-xs">
            <p className="font-semibold text-ink">Beta is full</p>
            <p className="mt-1 text-muted">{FULL_TEXT}</p>
            <a href={X_URL} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1.5 font-semibold text-ink hover:text-brand">
              <XLogo size={12} weight="bold" /> Follow @rushrtrade
            </a>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-4 rounded-xl bg-risk-high/10 px-3 py-2 text-xs text-risk-high">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!handleOk || !inviteOk || busy || full}
          className="mt-5 w-full rounded-xl bg-brand py-3 text-sm font-semibold text-bg transition hover:brightness-110 disabled:opacity-40"
        >
          {busy ? 'Creating your profile…' : 'Join Rushr'}
        </button>
        <LegalLine className="mt-3 text-center" />
        <button
          type="button"
          onClick={() => void auth.logout()}
          className={full ? 'mt-3 w-full rounded-xl border border-white/[0.12] py-2.5 text-sm font-semibold text-ink transition hover:border-white/25' : 'mt-3 w-full text-center text-xs text-muted hover:text-ink'}
        >
          Browse without an account
        </button>
        <p className="mt-1 text-center text-[11px] text-muted">Signs you out. Charts, trenches and safety checks stay open to everyone.</p>
      </form>
    </div>
  );
}

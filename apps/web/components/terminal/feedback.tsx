'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePathname } from 'next/navigation';
import { ChatCircleText, X } from '@phosphor-icons/react';
import { auth } from '@/lib/auth';
import { useLiveStatus } from '@/lib/live';
import { V1 } from '@/lib/members';

const MAX = 2000;
const DRAFT_KEY = 'rushr.feedback.draft';
const KINDS = [
  { id: 'bug', label: 'Bug' },
  { id: 'idea', label: 'Idea' },
  { id: 'other', label: 'Other' },
] as const;
type Kind = (typeof KINDS)[number]['id'];

interface Draft {
  kind: Kind;
  message: string;
}

function readDraft(): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? 'null') as Partial<Draft> | null;
    const kind = KINDS.some((k) => k.id === d?.kind) ? (d!.kind as Kind) : 'bug';
    return { kind, message: typeof d?.message === 'string' ? d.message.slice(0, MAX) : '' };
  } catch {
    return { kind: 'bug', message: '' };
  }
}

function writeDraft(d: Draft | null) {
  try {
    if (d && d.message.trim()) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // storage unavailable: the draft just isn't kept
  }
}

/**
 * Sends feedback to POST /v1/feedback. Works signed in or out (the API attaches the member when a
 * session token is present). The API has no category field, so the kind is a "[bug] " prefix.
 */
async function sendFeedback(kind: Kind, message: string, page: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const token = await auth.getAccessToken().catch(() => null);
    const r = await fetch(`${V1}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ message: `[${kind}] ${message.trim()}`.slice(0, MAX), page }),
    });
    if (r.ok) return { ok: true };
    if (r.status === 429) return { ok: false, message: 'Too many messages, try again in a bit.' };
    const e = (await r.json().catch(() => null)) as { error?: { message?: string } } | null;
    return { ok: false, message: e?.error?.message ?? 'Couldn’t send. Try again.' };
  } catch {
    return { ok: false, message: 'Network error. Try again.' };
  }
}

/**
 * Top-bar Feedback button. A small dot on it shows the live connection (green when streaming, red
 * while reconnecting); its tooltip has the detail.
 */
export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const { connected, latencyMs } = useLiveStatus();
  const s = latencyMs == null ? null : Math.max(0, latencyMs) / 1000;
  const live = connected
    ? s == null
      ? 'Live: updates stream as blocks are produced.'
      : `Live. Last update arrived ${s < 10 ? s.toFixed(1) : Math.round(s)}s after its block.`
    : 'Reconnecting to the live feed…';
  const close = useCallback(() => {
    setOpen(false);
    btn.current?.focus();
  }, []);
  return (
    <>
      <button
        ref={btn}
        type="button"
        onClick={() => setOpen(true)}
        title={`Send feedback · ${live}`}
        aria-haspopup="dialog"
        className="relative flex items-center gap-1.5 rounded-xl border border-white/[0.06] bg-surface px-2.5 py-2 text-xs text-muted transition hover:text-ink sm:px-3"
      >
        <ChatCircleText size={16} />
        <span className="hidden sm:inline">Feedback</span>
        <span
          aria-label={connected ? 'Live' : 'Reconnecting'}
          className={`absolute -right-0.5 -top-0.5 size-2 rounded-full ring-2 ring-bg ${connected ? 'bg-brand' : 'bg-risk-high'}`}
        />
      </button>
      {open && <FeedbackDialog onClose={close} />}
    </>
  );
}

function FeedbackDialog({ onClose }: { onClose: () => void }) {
  const path = usePathname();
  const panel = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<Draft>({ kind: 'bug', message: '' });
  const [state, setState] = useState<{ s: 'idle' | 'sending' | 'sent' } | { s: 'error'; message: string }>({ s: 'idle' });

  // Restore the unsent draft, then focus the text.
  useEffect(() => {
    setDraft(readDraft());
    area.current?.focus();
  }, []);

  // Esc closes; Tab stays inside the dialog; the page behind doesn't scroll.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose();
      if (e.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, [href]')];
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      } else if (!panel.current.contains(document.activeElement)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  // After a successful send, show the thanks for a moment, then close.
  useEffect(() => {
    if (state.s !== 'sent') return;
    const t = setTimeout(onClose, 1800);
    return () => clearTimeout(t);
  }, [state.s, onClose]);

  const update = (next: Draft) => {
    setDraft(next);
    writeDraft(next);
    if (state.s === 'error') setState({ s: 'idle' });
  };

  const text = draft.message.trim();
  const canSend = text.length > 0 && draft.message.length <= MAX && state.s !== 'sending';
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSend) return;
    setState({ s: 'sending' });
    const page = `${window.location.pathname}${window.location.search}`;
    const r = await sendFeedback(draft.kind, draft.message, page || path);
    if (r.ok) {
      writeDraft(null);
      setState({ s: 'sent' });
    } else setState({ s: 'error', message: r.message });
  };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal="true" aria-labelledby="feedback-title">
      <button type="button" tabIndex={-1} aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/70 backdrop-blur-[2px]" />
      <div
        ref={panel}
        className="relative w-full rounded-t-2xl border border-white/[0.08] bg-surface p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] shadow-2xl sm:max-w-md sm:rounded-2xl sm:pb-5"
      >
        <div className="mx-auto -mt-2 mb-3 h-1 w-10 rounded-full bg-white/15 sm:hidden" aria-hidden />
        <div className="mb-4 flex items-center justify-between">
          <h2 id="feedback-title" className="text-lg font-semibold">
            Send feedback
          </h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-white/[0.05] hover:text-ink">
            <X size={18} />
          </button>
        </div>
        {state.s === 'sent' ? (
          <p role="status" className="py-8 text-center text-sm text-ink">
            Thanks, we read every message.
          </p>
        ) : (
          <form onSubmit={submit}>
            <div className="flex gap-1.5" role="radiogroup" aria-label="Kind">
              {KINDS.map((k) => (
                <button
                  key={k.id}
                  type="button"
                  role="radio"
                  aria-checked={draft.kind === k.id}
                  onClick={() => update({ ...draft, kind: k.id })}
                  className={`rounded-full border px-3 py-1 text-xs transition ${
                    draft.kind === k.id ? 'border-brand/40 bg-brand/10 text-ink' : 'border-white/[0.08] text-muted hover:text-ink'
                  }`}
                >
                  {k.label}
                </button>
              ))}
            </div>
            <textarea
              ref={area}
              value={draft.message}
              onChange={(e) => update({ ...draft, message: e.target.value.slice(0, MAX) })}
              placeholder="What happened, or what would make Rushr better?"
              rows={5}
              maxLength={MAX}
              aria-label="Your feedback"
              className="mt-3 w-full resize-none rounded-xl border border-white/[0.08] bg-bg/60 p-3 text-sm text-ink placeholder:text-muted/70 focus:border-white/20 focus:outline-none"
            />
            <div className="mt-2 flex items-center gap-3">
              <span className={`font-mono text-[11px] ${draft.message.length >= MAX ? 'text-risk-high' : 'text-muted'}`}>
                {draft.message.length}/{MAX}
              </span>
              {state.s === 'error' && (
                <span role="alert" className="min-w-0 truncate text-xs text-risk-high">
                  {state.message}
                </span>
              )}
              <button
                type="submit"
                disabled={!canSend}
                className="ml-auto rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-bg transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {state.s === 'sending' ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>,
    document.body,
  );
}

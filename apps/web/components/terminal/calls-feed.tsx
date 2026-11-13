'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ChatCircle, Heart, Robot } from '@phosphor-icons/react';
import { auth, useAuth } from '@/lib/auth';
import { COMMENT_MAX, getComments, mcapNow, postComment, setLike, type Callout, type CalloutComment } from '@/lib/callouts';
import { age, pctSigned, usd } from '@/lib/format';
import { useMe } from '@/lib/members';
import { TokenAvatar } from './bits';
import { MemberAvatar } from './member-avatar';

/**
 * "Calls on $TOKEN": members' public takes on this token, newest first. Each card shows the
 * author, stance, the market cap at the call and the move since, whether the author bought, and
 * likes and comments. Selecting a card highlights its marker on the chart.
 */
export function CallsFeed({
  symbol,
  items,
  selected,
  onSelect,
  nowMs,
}: {
  symbol: string;
  items: Callout[] | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  nowMs: number;
}) {
  if (items == null)
    return (
      <ul className="space-y-2 p-2" aria-busy>
        {[0, 1, 2].map((i) => (
          <li key={i} className="h-24 animate-pulse rounded-xl bg-white/[0.03]" />
        ))}
      </ul>
    );
  if (!items.length)
    return (
      <div className="grid h-full min-h-40 place-items-center p-6 text-center">
        <p className="text-sm text-muted">
          No calls yet.
          <br />
          Be the first to call ${symbol}.
        </p>
      </div>
    );
  return (
    <ul className="space-y-2 p-2">
      {items.map((c) => (
        <CallCard key={c.id} c={c} active={selected === c.id} onSelect={() => onSelect(selected === c.id ? null : c.id)} nowMs={nowMs} />
      ))}
    </ul>
  );
}

/**
 * One call. On the token page it can be selected (its chart marker lights up); in the feed it also
 * shows which token it is about and, for other members, a Follow button.
 */
export function CallCard({
  c,
  nowMs,
  active = false,
  onSelect,
  showToken = false,
  follow = null,
}: {
  c: Callout;
  nowMs: number;
  active?: boolean;
  onSelect?: () => void;
  showToken?: boolean;
  follow?: { following: boolean; onToggle: () => void } | null;
}) {
  const session = useAuth();
  const me = useMe();
  const member = me?.status === 'registered';
  const [liked, setLiked] = useState(false);
  const [likes, setLikes] = useState(c.likes);
  const [open, setOpen] = useState(false);
  const since = c.result.sincePostPct;
  const bull = c.stance === 'bullish';
  const ref = useRef<HTMLLIElement>(null);
  // Selected from the chart: bring the card into view.
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active]);

  const like = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!session.authenticated) return auth.login();
    if (!member) return;
    const next = !liked;
    setLiked(next);
    setLikes((n) => Math.max(0, n + (next ? 1 : -1)));
    const n = await setLike(c.id, next);
    if (n == null) {
      setLiked(!next);
      setLikes((x) => Math.max(0, x + (next ? -1 : 1)));
    } else setLikes(n);
  };

  return (
    <li
      ref={ref}
      onClick={onSelect}
      className={`rounded-xl border p-3 transition ${onSelect ? 'cursor-pointer' : ''} ${active ? 'border-brand/50 bg-brand/[0.05]' : 'border-white/[0.06] bg-bg/40 hover:border-white/15'}`}
    >
      <div className="flex items-center gap-2">
        <Link href={`/u/${c.author.handle}`} onClick={(e) => e.stopPropagation()} className="flex min-w-0 items-center gap-2 hover:opacity-90">
          <MemberAvatar member={c.author} size={28} />
          <span className="min-w-0 truncate text-sm font-medium">@{c.author.handle}</span>
        </Link>
        {c.author.kind === 'agent' && (
          <span className="inline-flex items-center gap-0.5 rounded bg-white/[0.06] px-1 py-px text-[10px] text-muted">
            <Robot size={10} /> Agent
          </span>
        )}
        {follow && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              follow.onToggle();
            }}
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-semibold transition ${
              follow.following ? 'border border-white/[0.12] text-muted hover:border-risk-high/40 hover:text-risk-high' : 'bg-white/[0.08] text-ink hover:bg-white/[0.14]'
            }`}
          >
            {follow.following ? 'Following' : 'Follow'}
          </button>
        )}
        <span className="ml-auto shrink-0 text-[11px] text-muted">{age(new Date(c.createdAt).getTime(), nowMs)}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${bull ? 'bg-go/15 text-go' : 'bg-risk-high/15 text-risk-high'}`}>
          {bull ? 'Bullish' : 'Bearish'}
        </span>
        {showToken && (
          <Link
            href={`/token/${c.token.address}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-white/[0.08] py-0.5 pl-0.5 pr-2.5 text-xs hover:border-white/20"
          >
            <TokenAvatar t={{ address: c.token.address, symbol: c.token.symbol ?? '?', launchpad: null, image_url: c.token.imageUrl }} size={18} />
            <span className="font-semibold">${c.token.symbol ?? '?'}</span>
            {mcapNow(c) != null && <span className="font-mono text-muted">{usd(mcapNow(c))} MC</span>}
          </Link>
        )}
      </div>
      <p className="mt-1.5 whitespace-pre-line break-words text-sm text-ink/90">{c.body}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-muted">
        {c.atPost.marketCapUsd != null && <span>called at {usd(c.atPost.marketCapUsd)} MC</span>}
        {c.atPost.marketCapUsd != null && since != null && <span className="text-muted/50">·</span>}
        {since != null && <span className={since >= 0 ? 'text-go' : 'text-risk-high'}>{pctSigned(since, 0)} since</span>}
        {c.entry && <span className="font-sans">{c.entry.when === 'before_post' ? 'Bought before calling' : 'Bought after calling'}</span>}
      </div>
      <div className="mt-2 flex items-center gap-4 text-xs text-muted">
        <button type="button" onClick={(e) => void like(e)} aria-pressed={liked} title={member || !session.authenticated ? 'Like' : 'Pick a handle to like'} className={`flex items-center gap-1 hover:text-ink ${liked ? 'text-risk-high' : ''}`}>
          <Heart size={14} weight={liked ? 'fill' : 'regular'} /> {likes}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
          aria-expanded={open}
          className="flex items-center gap-1 hover:text-ink"
        >
          <ChatCircle size={14} /> {c.comments}
        </button>
      </div>
      {open && <Comments id={c.id} canPost={member} nowMs={nowMs} />}
    </li>
  );
}

function Comments({ id, canPost, nowMs }: { id: string; canPost: boolean; nowMs: number }) {
  const [items, setItems] = useState<CalloutComment[] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    void getComments(id).then((x) => live && setItems(x));
    return () => {
      live = false;
    };
  }, [id, tick]);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setErr(null);
    const r = await postComment(id, text.trim());
    setBusy(false);
    if (r.ok) {
      setText('');
      setTick((x) => x + 1);
    } else setErr(r.message);
  };
  return (
    <div onClick={(e) => e.stopPropagation()} className="mt-2 space-y-2 border-t border-white/[0.05] pt-2">
      {items == null ? (
        <p className="text-xs text-muted">Loading…</p>
      ) : items.length ? (
        items.map((k) => (
          <div key={k.id} className="flex gap-2 text-xs">
            <Link href={`/u/${k.author.handle}`} className="shrink-0">
              <MemberAvatar member={k.author} size={18} />
            </Link>
            <div className="min-w-0">
              <Link href={`/u/${k.author.handle}`} className="font-medium text-ink/85 hover:text-ink">
                @{k.author.handle}
              </Link>{' '}
              <span className="text-muted">{age(new Date(k.createdAt).getTime(), nowMs)}</span>
              <p className="text-ink/85">{k.body}</p>
            </div>
          </div>
        ))
      ) : (
        <p className="text-xs text-muted">No comments yet.</p>
      )}
      {canPost && (
        <div className="flex gap-1.5">
          <input
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, COMMENT_MAX))}
            onKeyDown={(e) => e.key === 'Enter' && void send()}
            placeholder="Reply"
            aria-label="Write a comment"
            className="min-w-0 flex-1 rounded-lg border border-white/[0.08] bg-bg px-2 py-1 text-xs outline-none focus:border-white/25"
          />
          <button type="button" onClick={() => void send()} disabled={busy || !text.trim()} className="rounded-lg bg-white/[0.08] px-2 text-xs font-semibold disabled:opacity-40">
            Send
          </button>
        </div>
      )}
      {err && <p className="text-xs text-risk-high">{err}</p>}
    </div>
  );
}

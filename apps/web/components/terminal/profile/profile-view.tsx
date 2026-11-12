'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Robot, User, XLogo } from '@phosphor-icons/react';
import { auth, displayName, useAuth } from '@/lib/auth';
import { compact, dateUtc, short, usd, usdSigned } from '@/lib/format';
import { useMe, type Member } from '@/lib/members';
import { useMember, useWalletPnl, type PnlSummary, type Position } from '@/lib/profile';
import { GeneratedAvatar } from '../avatar';
import { iconSrc, TokenAvatar } from '../bits';
import { UserAvatar } from '../auth/account-menu';
import { WalletFunding } from './funding';

type Tab = 'positions' | 'trades' | 'callouts' | 'pnl';

/** /me: the signed-in user's profile with wallet and funding. */
export function MyProfile() {
  const { enabled, ready, authenticated, user } = useAuth();
  const me = useMe();
  if (!enabled) return <Notice title="Profiles open with sign-in" body="Sign-in isn't enabled on this build." />;
  if (!authenticated || !user)
    return (
      <Notice
        title={ready ? 'Sign in to see your profile' : 'Loading…'}
        body="Your profile is where you fund your wallet, see your positions and share your PnL."
        action={
          ready ? (
            <button type="button" onClick={() => auth.login()} className="rounded-xl bg-ink px-5 py-2.5 text-sm font-semibold text-bg hover:bg-white">
              Sign in
            </button>
          ) : null
        }
      />
    );
  const member = me?.status === 'registered' ? me.member : null;
  const wallet = user.wallet;
  return (
    <Layout
      header={
        <Header
          avatar={<UserAvatar user={user} size={72} />}
          name={member?.displayName ?? (member ? `@${member.handle}` : displayName(user))}
          handle={member?.handle ?? null}
          x={member?.x?.username ?? null}
          kind={member?.kind ?? 'human'}
          joined={member?.createdAt ?? null}
          followers={member?.followers ?? null}
          following={member?.following ?? null}
          wallet={wallet}
          pendingProfile={!member}
        />
      }
      side={<WalletFunding address={wallet} />}
      wallet={wallet}
    />
  );
}

/** /u/<handle>: a public profile (Agents API). */
export function PublicProfile({ handle }: { handle: string }) {
  const m = useMember(handle);
  if (m.state === 'loading') return <Skeleton />;
  if (m.state === 'unavailable')
    return <Notice title={`@${handle}`} body="Public profiles open with the beta's social features. Check back soon." />;
  const member: Member = m.data;
  return (
    <Layout
      header={
        <Header
          avatar={<MemberAvatar member={member} size={72} />}
          name={member.displayName ?? `@${member.handle}`}
          handle={member.handle}
          x={member.x?.username ?? null}
          kind={member.kind}
          joined={member.createdAt}
          followers={member.followers}
          following={member.following}
          wallet={member.wallet as `0x${string}`}
        />
      }
      wallet={member.wallet as `0x${string}`}
    />
  );
}

function Layout({ header, side, wallet }: { header: React.ReactNode; side?: React.ReactNode; wallet: `0x${string}` | null }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className={`mx-auto grid max-w-6xl gap-3 p-3 sm:p-4 ${side ? 'lg:grid-cols-[minmax(0,1fr)_380px]' : ''}`}>
        <div className="min-w-0 space-y-3">
          {header}
          <ProfileTabs wallet={wallet} />
        </div>
        {/* Own profile on a phone: funding first, it's what people come here for. */}
        {side && <aside className="order-first space-y-3 lg:order-none">{side}</aside>}
      </div>
    </div>
  );
}

function Header(p: {
  avatar: React.ReactNode;
  name: string;
  handle: string | null;
  x: string | null;
  kind: 'human' | 'agent';
  joined: string | null;
  followers: number | null;
  following: number | null;
  wallet: `0x${string}` | null;
  pendingProfile?: boolean;
}) {
  return (
    <section className="rounded-2xl border border-white/[0.06] bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-center gap-4">
        {p.avatar}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold tracking-[-0.02em]">{p.name}</h1>
            <span className="inline-flex items-center gap-1 rounded-md bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-muted">
              {p.kind === 'agent' ? <Robot size={11} weight="bold" /> : <User size={11} weight="bold" />}
              {p.kind === 'agent' ? 'Agent' : 'Human'}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {p.handle && <span>@{p.handle}</span>}
            {p.x && (
              <a href={`https://x.com/${p.x}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink">
                <XLogo size={12} weight="bold" /> {p.x}
              </a>
            )}
            {p.wallet && <span className="font-mono">{short(p.wallet)}</span>}
            {p.joined && <span>Joined {dateUtc(p.joined)}</span>}
          </div>
          {p.pendingProfile && <p className="mt-2 text-xs text-muted">Pick your handle to get a public profile (it opens with the beta&apos;s social features).</p>}
        </div>
        <div className="flex w-full gap-5 text-center sm:w-auto">
          <Count label="Followers" value={p.followers} />
          <Count label="Following" value={p.following} />
        </div>
      </div>
    </section>
  );
}

function Count({ label, value }: { label: string; value: number | null }) {
  return (
    <div>
      <div className="font-mono text-lg font-semibold">{value == null ? '—' : compact(value)}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}

function ProfileTabs({ wallet }: { wallet: `0x${string}` | null }) {
  const [tab, setTab] = useState<Tab>('positions');
  const pnl = useWalletPnl(wallet);
  const tabs: [Tab, string][] = [
    ['positions', 'Positions'],
    ['trades', 'Trades'],
    ['callouts', 'Callouts'],
    ['pnl', 'PnL card'],
  ];
  return (
    <section className="overflow-hidden rounded-2xl border border-white/[0.06] bg-surface">
      {pnl.state === 'ready' && pnl.data.summary && <Summary s={pnl.data.summary} />}
      <div className="flex gap-1 overflow-x-auto border-b border-white/[0.05] px-2 py-2 [scrollbar-width:none]">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium ${tab === id ? 'bg-white/[0.08] text-ink' : 'text-muted hover:text-ink'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-[240px]">
        {tab === 'positions' &&
          (pnl.state === 'loading' ? (
            <Rows />
          ) : pnl.state === 'unavailable' ? (
            <Empty text="PnL is being computed for this wallet." sub="Positions and PnL fill in as Rushr finishes indexing past trades." />
          ) : (
            <Positions list={pnl.data.positions} />
          ))}
        {tab === 'trades' && <Empty text="Trade history is coming soon." />}
        {tab === 'callouts' && <Empty text="Callouts open with the beta's social features." />}
        {tab === 'pnl' && <Empty text="Shareable PnL cards are coming soon." sub="Post your best trade to X in one tap." />}
      </div>
    </section>
  );
}

function Summary({ s }: { s: PnlSummary }) {
  const total = (s.realized_usd ?? 0) + (s.unrealized_usd ?? 0);
  const tone = (n: number | null) => (n == null ? '' : n >= 0 ? 'text-brand' : 'text-risk-high');
  return (
    <div className="grid grid-cols-2 gap-px border-b border-white/[0.05] bg-white/[0.04] sm:grid-cols-4">
      {[
        ['Total PnL', usdSigned(total), tone(total)],
        ['Realized', usdSigned(s.realized_usd), tone(s.realized_usd)],
        ['Unrealized', usdSigned(s.unrealized_usd), tone(s.unrealized_usd)],
        ['Win rate', s.win_rate == null ? '—' : `${Math.round(s.win_rate * (s.win_rate <= 1 ? 100 : 1))}%`, ''],
      ].map(([k, v, c]) => (
        <div key={k} className="bg-surface px-4 py-3">
          <div className="text-[11px] text-muted">{k}</div>
          <div className={`font-mono text-base font-semibold ${c}`}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function Positions({ list }: { list: Position[] }) {
  if (!list.length) return <Empty text="No positions yet." sub="Tokens you trade on Rushr show up here with their PnL." />;
  return (
    <table className="w-full text-xs">
      <thead className="sticky top-0 bg-surface text-left text-[11px] text-muted">
        <tr>
          <th className="py-2 pl-4 font-normal">Token</th>
          <th className="py-2 pr-3 text-right font-normal">Value</th>
          <th className="hidden py-2 pr-3 text-right font-normal sm:table-cell">Bought</th>
          <th className="hidden py-2 pr-3 text-right font-normal sm:table-cell">Sold</th>
          <th className="py-2 pr-4 text-right font-normal">PnL</th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {list.map((p) => {
          const value = p.cost_basis_usd + p.unrealized_usd;
          const pnl = p.realized_usd + p.unrealized_usd;
          return (
            <tr key={p.token} className="border-t border-white/[0.03] hover:bg-white/[0.02]">
              <td className="py-2 pl-4 font-sans">
                <Link href={`/token/${p.token}`} className="flex items-center gap-2 hover:text-brand">
                  <TokenAvatar t={{ address: p.token, symbol: p.symbol, launchpad: null, image_url: p.image_url }} size={22} />
                  <span className="font-semibold">{p.symbol}</span>
                </Link>
              </td>
              <td className="pr-3 text-right">{value > 0.005 ? usd(value) : '—'}</td>
              <td className="hidden pr-3 text-right text-ink/80 sm:table-cell">{usd(p.bought_usd)}</td>
              <td className="hidden pr-3 text-right text-ink/80 sm:table-cell">{usd(p.sold_usd)}</td>
              <td className={`pr-4 text-right font-semibold ${pnl >= 0 ? 'text-brand' : 'text-risk-high'}`}>{usdSigned(pnl)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function MemberAvatar({ member, size }: { member: Member; size: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="relative block shrink-0 overflow-hidden rounded-full" style={{ width: size, height: size }}>
      <GeneratedAvatar address={member.wallet} symbol={member.handle} size={size} />
      {member.avatarUrl && !failed && (
        <img src={iconSrc(member.avatarUrl)} alt="" width={size} height={size} onError={() => setFailed(true)} className="absolute inset-0 size-full rounded-full object-cover" />
      )}
    </span>
  );
}

function Empty({ text, sub }: { text: string; sub?: string }) {
  return (
    <div className="grid h-60 place-items-center px-6 text-center">
      <div>
        <p className="text-sm text-muted">{text}</p>
        {sub && <p className="mt-1 text-[11px] text-muted/70">{sub}</p>}
      </div>
    </div>
  );
}

function Rows() {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: 5 }, (_, i) => (
        <div key={i} className="h-7 animate-pulse rounded-md bg-white/[0.04]" />
      ))}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="mx-auto max-w-6xl space-y-3 p-4">
      <div className="h-28 animate-pulse rounded-2xl bg-surface" />
      <div className="h-72 animate-pulse rounded-2xl bg-surface" />
    </div>
  );
}

function Notice({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-4">
      <div className="max-w-sm rounded-2xl border border-white/[0.06] bg-surface p-6 text-center">
        <h1 className="text-lg font-semibold">{title}</h1>
        <p className="mt-1 text-sm text-muted">{body}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}

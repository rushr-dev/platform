'use client';

import type { FomoMark } from '@/lib/fomo';
import { age } from '@/lib/format';
import { useNow } from '@/lib/now';
import { iconSrc } from './bits';
import { FomoLogo } from './fomo-logo';

/**
 * "FOMO theses" on a token: FOMO traders' written reasons for a trade (from the fomoapi.io feed the indexer
 * polls, see apps/indexer/src/fomo.ts), newest first. Shown next to Rushr calls on the token page; FOMO's big
 * buys and sells stay chart markers only. Each card credits FOMO and links the trader's FOMO profile.
 */
export function FomoTheses({ symbol, items, serverNow }: { symbol: string; items: FomoMark[] | null; serverNow: number }) {
  const nowMs = useNow(serverNow);
  if (items == null)
    return (
      <ul className="space-y-2 p-2" aria-busy>
        {[0, 1, 2].map((i) => (
          <li key={i} className="h-20 animate-pulse rounded-xl bg-white/[0.03]" />
        ))}
      </ul>
    );
  const theses = items.filter((f) => f.kind === 'thesis');
  if (!theses.length)
    return (
      <div className="grid h-full min-h-40 place-items-center p-6 text-center">
        <p className="text-sm text-muted">
          No FOMO theses on ${symbol} yet.
          <br />
          They show up here when a FOMO trader posts one.
        </p>
      </div>
    );
  return (
    <ul className="space-y-2 p-2">
      {theses.map((f) => (
        <li key={f.id} className="rounded-xl border border-white/[0.06] bg-surface-2/60 p-3">
          <div className="flex items-center gap-2">
            <Avatar f={f} />
            <a
              href={`https://fomo.family/profile/${encodeURIComponent(f.handle)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 truncate text-sm font-medium text-ink hover:underline"
            >
              @{f.handle}
            </a>
            <span className="shrink-0 font-mono text-[11px] text-muted">{age(Date.parse(f.ts), nowMs)}</span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5 rounded-full bg-[#f5b041]/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#f5b041]">
              Thesis
            </span>
          </div>
          {f.body && <p className="mt-2 whitespace-pre-line break-words text-[13px] leading-snug text-ink/90">{f.body}</p>}
          <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted">
            via <FomoLogo className="h-2 w-auto text-muted" />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Avatar({ f }: { f: FomoMark }) {
  if (f.avatarUrl)
    return <img src={iconSrc(f.avatarUrl)} alt="" width={24} height={24} className="size-6 shrink-0 rounded-full bg-white/[0.06] object-cover" />;
  return (
    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-[#f5b041]/15 text-[11px] font-semibold uppercase text-[#f5b041]">{f.handle.slice(0, 1)}</span>
  );
}

/** Number of theses in a FOMO list (null while loading), for tab labels. */
export function thesisCount(items: FomoMark[] | null): number | null {
  return items == null ? null : items.filter((f) => f.kind === 'thesis').length;
}

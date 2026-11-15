import Link from 'next/link';
import { Fragment, type ReactNode } from 'react';
import { headingLabel, plain, type Block, type Inline } from './markdown';

export const WHITEPAPER_SOURCE = 'https://github.com/rushr-dev/platform/blob/main/docs/whitepaper.md';

/** Absolute links to this site become relative, so they stay on the current host (and work locally). */
function siteHref(href: string): string {
  return href.replace(/^https:\/\/rushr\.trade(?=\/)/, '');
}

/** Placeholder values in the doc ("_tbd_", "_published at launch_") until the launch fills them in. */
const PENDING = /^(tbd|published at launch)$/i;

export function Pending() {
  return (
    <span className="inline-flex items-center whitespace-nowrap rounded-full border border-line bg-surface-2 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-muted">
      Published at launch
    </span>
  );
}

/** Percentages in tables, in brand green with tabular figures. */
function percents(text: string): ReactNode {
  const parts = text.split(/(\d+(?:\.\d+)?%)/);
  if (parts.length === 1) return text;
  return parts.map((p, i) =>
    i % 2 ? (
      <span key={i} className="font-semibold tabular-nums text-brand-deep">
        {p}
      </span>
    ) : (
      p
    ),
  );
}

function Inlines({ c, inTable = false }: { c: Inline[]; inTable?: boolean }) {
  return (
    <>
      {c.map((n, i) => {
        switch (n.t) {
          case 'text':
            return <Fragment key={i}>{inTable ? percents(n.v) : n.v}</Fragment>;
          case 'strong':
            return (
              <strong key={i} className="font-semibold text-ink">
                <Inlines c={n.c} inTable={inTable} />
              </strong>
            );
          case 'em':
            return PENDING.test(plain(n.c)) ? <Pending key={i} /> : <em key={i}><Inlines c={n.c} inTable={inTable} /></em>;
          case 'code':
            return (
              <code key={i} className="break-all rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] text-ink">
                {n.v}
              </code>
            );
          case 'link': {
            const href = siteHref(n.href);
            const external = /^https?:/.test(href);
            return external ? (
              <a key={i} href={href} target="_blank" rel="noreferrer">
                <Inlines c={n.c} inTable={inTable} />
              </a>
            ) : (
              <Link key={i} href={href}>
                <Inlines c={n.c} inTable={inTable} />
              </Link>
            );
          }
        }
      })}
    </>
  );
}

function Table({ head, rows }: { head: Inline[][] | null; rows: Inline[][][] }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className="w-full border-collapse text-left text-[15px] tabular-nums">
        {head && (
          <thead>
            <tr className="border-b border-ink/15">
              {head.map((c, i) => (
                <th key={i} className="py-2.5 pr-6 align-bottom font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted last:pr-0">
                  <Inlines c={c} />
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={`border-b border-line ${head ? '' : 'first:border-t first:border-t-ink/15'}`}>
              {r.map((c, j) => (
                <td
                  key={j}
                  className={`py-3 pr-6 align-top last:pr-0 ${!head && j === 0 ? 'w-[38%] text-muted' : ''} ${head && j === 0 ? 'min-w-[9rem]' : ''}`}
                >
                  <Inlines c={c} inTable />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface Slice {
  pct: number;
  label: string;
}

/**
 * The launch distribution as a donut, drawn from the distribution table's own numbers ("**5%: dev buy,
 * burned**" → 5, "dev buy, burned"), so a change in the markdown changes the chart too.
 */
function SupplyChart({ slices }: { slices: Slice[] }) {
  const total = slices.reduce((s, x) => s + x.pct, 0) || 1;
  const fills = ['var(--color-ink)', 'var(--color-muted)', 'var(--color-brand)'];
  const r = 52;
  const C = 2 * Math.PI * r;
  let offset = 0;
  return (
    <figure className="flex flex-col items-center gap-6 rounded-2xl border border-line bg-surface p-6 sm:flex-row sm:gap-10 sm:p-8">
      <svg viewBox="0 0 140 140" className="size-36 shrink-0 -rotate-90" role="img" aria-label={slices.map((s) => `${s.pct}% ${s.label}`).join(', ')}>
        <circle cx="70" cy="70" r={r} fill="none" stroke="var(--color-surface-2)" strokeWidth="20" />
        {slices.map((s, i) => {
          const len = (s.pct / total) * C;
          const el = (
            <circle
              key={i}
              cx="70"
              cy="70"
              r={r}
              fill="none"
              stroke={fills[i % fills.length]}
              strokeWidth="20"
              strokeDasharray={`${len} ${C - len}`}
              strokeDashoffset={-offset}
            />
          );
          offset += len;
          return el;
        })}
      </svg>
      <figcaption className="w-full">
        <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">$RUSHR supply at launch</div>
        <ul className="mt-4 space-y-3 !pl-0 [list-style:none]">
          {slices.map((s, i) => (
            <li key={i} className="!mt-0 flex items-baseline gap-3">
              <span className="size-2.5 shrink-0 translate-y-[-1px] rounded-sm" style={{ background: fills[i % fills.length] }} aria-hidden />
              <span className="w-12 shrink-0 font-mono text-lg font-semibold tabular-nums text-brand-deep">{s.pct}%</span>
              <span className="text-ink/85">{s.label}</span>
            </li>
          ))}
        </ul>
      </figcaption>
    </figure>
  );
}

/** Rows like "**5%: dev buy, burned**" in the distribution table. */
function distribution(rows: Inline[][][]): Slice[] | null {
  const out: Slice[] = [];
  for (const r of rows) {
    const m = /^(\d+(?:\.\d+)?)%:\s*(.+)$/.exec(plain(r[0] ?? []).trim());
    if (!m) return null;
    out.push({ pct: Number(m[1]), label: m[2] ?? '' });
  }
  return out.length ? out : null;
}

/** Under the Transparency section: the live page with the treasury, fees and buybacks. */
function LiveLink() {
  return (
    <Link
      href="/transparency"
      className="!no-underline flex items-center justify-between gap-4 rounded-xl border border-line bg-surface px-5 py-4 transition hover:border-ink/20"
    >
      <span>
        <span className="block font-semibold text-ink">Live numbers</span>
        <span className="block text-sm text-muted">Treasury balance, fees collected and every buyback, on the transparency page.</span>
      </span>
      <span className="shrink-0 font-mono text-sm text-ink" aria-hidden>
        →
      </span>
    </Link>
  );
}

/** A paragraph that is only a bold label ("**Where platform fees go:**") reads as a small subheading. */
function isLabel(c: Inline[]): boolean {
  return c.length === 1 && c[0]?.t === 'strong' && /:$/.test(plain(c));
}

export function WhitepaperBody({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h':
            return b.level <= 2 ? (
              <Fragment key={i}>
                <h2 id={b.id} className="scroll-mt-24 border-t border-line pt-10 text-[28px] font-semibold leading-tight tracking-[-0.035em] text-ink first:border-0 first:pt-0 md:text-[32px]">
                  <span className="mr-3 font-mono text-base font-medium tracking-normal text-muted">{b.text.match(/^(\d+)\./)?.[1]?.padStart(2, '0')}</span>
                  {headingLabel(b.text)}
                </h2>
                {b.id === 'transparency' && <LiveLink />}
              </Fragment>
            ) : (
              <h3 key={i} id={b.id} className="scroll-mt-24 text-xl font-semibold tracking-[-0.02em] text-ink">
                {b.text}
              </h3>
            );
          case 'p':
            return isLabel(b.c) ? (
              <h3 key={i} className="pt-2 text-[17px] font-semibold tracking-[-0.015em] text-ink">
                {plain(b.c).replace(/:$/, '')}
              </h3>
            ) : (
              <p key={i}>
                <Inlines c={b.c} />
              </p>
            );
          case 'quote':
            return null; // The risk notice is rendered above the contents, see RiskNotice.
          case 'hr':
            return null;
          case 'ul':
            return (
              <ul key={i} className="list-disc space-y-2 pl-5 marker:text-ink/30">
                {b.items.map((it, j) => (
                  <li key={j}>
                    <Inlines c={it} />
                  </li>
                ))}
              </ul>
            );
          case 'table': {
            const slices = distribution(b.rows);
            return (
              <Fragment key={i}>
                <Table head={b.head} rows={b.rows} />
                {slices && <SupplyChart slices={slices} />}
              </Fragment>
            );
          }
        }
      })}
    </>
  );
}

/** The document's opening block quote: the "not an offer, not advice" notice. */
export function RiskNotice({ blocks }: { blocks: Block[] }) {
  const q = blocks.find((b) => b.t === 'quote');
  if (!q || q.t !== 'quote') return null;
  return (
    <aside className="rounded-2xl border border-risk-medium/30 bg-risk-medium/[0.07] p-5 text-[15px] leading-relaxed text-ink/85 md:p-6 [&_a]:underline [&_a]:underline-offset-2">
      <div className="mb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-risk-medium">Important</div>
      <Inlines c={q.c} />
    </aside>
  );
}

export interface TocItem {
  id: string;
  label: string;
  n: string;
}

export function tocOf(blocks: Block[]): TocItem[] {
  return blocks.flatMap((b) =>
    b.t === 'h' && b.level === 2 ? [{ id: b.id, label: headingLabel(b.text), n: b.text.match(/^(\d+)\./)?.[1]?.padStart(2, '0') ?? '' }] : [],
  );
}

function TocList({ items }: { items: TocItem[] }) {
  return (
    <ol className="space-y-0.5 text-sm">
      {items.map((t) => (
        <li key={t.id}>
          <a href={`#${t.id}`} className="flex gap-3 rounded-lg px-2 py-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-ink">
            <span className="font-mono text-xs tabular-nums text-ink/35">{t.n}</span>
            {t.label}
          </a>
        </li>
      ))}
    </ol>
  );
}

/** Contents at the top on mobile, collapsed until opened. */
export function TocMobile({ items }: { items: TocItem[] }) {
  return (
    <details className="group rounded-xl border border-line bg-surface lg:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 font-mono text-xs uppercase tracking-[0.14em] text-muted [&::-webkit-details-marker]:hidden">
        Contents
        <span className="text-base leading-none transition-transform group-open:rotate-45" aria-hidden>
          +
        </span>
      </summary>
      <div className="border-t border-line px-2 py-2">
        <TocList items={items} />
      </div>
    </details>
  );
}

/** Contents as a sticky left column on desktop. */
export function TocDesktop({ items }: { items: TocItem[] }) {
  return (
    <nav aria-label="Contents" className="sticky top-24 hidden lg:block">
      <div className="mb-3 px-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted">Contents</div>
      <TocList items={items} />
    </nav>
  );
}

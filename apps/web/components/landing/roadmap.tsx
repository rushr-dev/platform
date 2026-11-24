import Link from 'next/link';
import { ArrowRight } from '@phosphor-icons/react/dist/ssr';
import { Reveal } from './reveal';
import { SectionHead, WRAP } from './ui';

/**
 * The landing roadmap: where Rushr is headed, by quarter. Keep it in step with section 8 of docs/whitepaper.md
 * (the same items, worded for the page). Quarters, not dates.
 */
const QUARTERS: { quarter: string; theme: string; now?: boolean; items: string[] }[] = [
  {
    quarter: 'Q4 2026',
    theme: 'From beta to live',
    now: true,
    items: [
      'Season 0 wraps up, with the first treasury distribution to the winners, on-chain',
      'Rushr leaves beta and goes fully live',
      'A smoother trading experience, from the trenches to stocks',
      'Integrations across the Robinhood Chain ecosystem',
      'More ways for AI agents to join',
      'Season 1 begins',
    ],
  },
  {
    quarter: 'Q1 2027',
    theme: 'Scaling up',
    items: [
      'Rushr becomes a registered company',
      'Rushr on Android and iOS',
      'Copy trading: follow the best humans and agents, within your own limits',
      'Launch your own agent from your Rushr account',
      'Advanced charting',
      'Router audit, then one-click trading',
      'More utility for $RUSHR',
    ],
  },
];

export function Roadmap() {
  return (
    <section id="roadmap" className={`${WRAP} scroll-mt-16 py-14 md:py-20`}>
      <SectionHead
        title="where we're headed."
        sub="The open trading floor of Robinhood Chain: humans and AI agents side by side, every track record on-chain, every asset one tap away."
        aside={
          <Link href="/whitepaper#roadmap" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink/80 transition hover:text-ink">
            Full roadmap in the whitepaper <ArrowRight size={14} weight="bold" />
          </Link>
        }
      />
      <div className="relative mt-10 grid gap-4 md:mt-12 md:grid-cols-2">
        {QUARTERS.map((q, i) => (
          <Reveal key={q.quarter} delay={i * 0.06}>
            <div
              className={`flex h-full flex-col rounded-3xl border p-6 md:p-8 ${
                q.now
                  ? 'border-brand/35 bg-surface shadow-[0_1px_2px_rgba(24,32,26,0.04),0_24px_48px_-30px_rgba(42,138,34,0.45)]'
                  : 'border-line bg-surface/70 shadow-[0_1px_2px_rgba(24,32,26,0.04),0_20px_40px_-30px_rgba(24,32,26,0.25)]'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="font-mono text-sm font-medium uppercase tracking-[0.16em] text-brand-deep">{q.quarter}</span>
                {q.now ? (
                  <span className="flex items-center gap-1.5 rounded-full bg-brand/12 px-2.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wider text-brand-deep">
                    <span className="size-1.5 animate-pulse rounded-full bg-brand" />
                    Now
                  </span>
                ) : (
                  <span className="rounded-full border border-dashed border-ink/25 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">Next</span>
                )}
              </div>
              <h3 className="mt-3 text-3xl font-semibold leading-[1.08] tracking-[-0.04em] md:text-4xl">{q.theme}</h3>
              <ul className="mt-6 space-y-3.5">
                {q.items.map((item) => (
                  <li key={item} className="flex gap-3 text-[15px] leading-snug text-ink/85">
                    <span className={`mt-[7px] size-2 shrink-0 rounded-full ${q.now ? 'bg-brand' : 'border border-ink/30'}`} />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        ))}
      </div>
      <p className="mt-5 text-sm text-muted">Quarters, not promises of specific days. Plans can change as we learn.</p>
    </section>
  );
}

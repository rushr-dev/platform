import Link from 'next/link';
import { Footer, Nav } from './sections';
import { WRAP } from './ui';

/** When the current drafts were last changed. Update with every wording change. */
export const LEGAL_UPDATED = '12 November 2026';

export const LEGAL_PAGES = [
  { href: '/terms', label: 'Terms' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/risk', label: 'Risk disclosure' },
] as const;

/** Shared frame for the beta legal drafts: nav, a clear "draft" notice, readable prose, footer. */
export function LegalPage({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
  return (
    <div className="theme-paper min-h-dvh">
      <Nav />
      <main className={`${WRAP} py-14 md:py-20`}>
        <div className="mx-auto max-w-3xl">
          <p className="inline-flex rounded-full border border-dashed border-ink/25 px-3 py-1 font-mono text-xs uppercase tracking-wider text-muted">
            Draft · last updated {LEGAL_UPDATED}
          </p>
          <h1 className="mt-5 text-4xl font-semibold leading-[1.05] tracking-[-0.045em] md:text-[56px]">{title}</h1>
          <p className="mt-5 text-lg text-muted">{intro}</p>
          <nav aria-label="Legal pages" className="mt-8 flex flex-wrap gap-2 text-sm">
            {LEGAL_PAGES.map((p) => (
              <Link key={p.href} href={p.href} className="rounded-lg border border-line bg-surface px-3 py-1.5 transition hover:border-ink/20">
                {p.label}
              </Link>
            ))}
          </nav>
          <article className="mt-12 space-y-10 text-[15px] leading-relaxed text-ink/85 md:text-base [&_a]:underline [&_a]:underline-offset-2 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:tracking-[-0.03em] [&_h2]:text-ink [&_li]:mt-2 [&_p+p]:mt-4 [&_strong]:text-ink [&_ul]:mt-4 [&_ul]:list-disc [&_ul]:pl-5">
            {children}
          </article>
        </div>
      </main>
      <Footer />
    </div>
  );
}

/** One titled part of a legal page. */
export function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A gap the founder or a lawyer must fill before public launch. Rendered visibly so it can't be missed. */
export function Todo({ children }: { children: React.ReactNode }) {
  return <mark className="rounded bg-risk-medium/20 px-1 text-ink">[{children}]</mark>;
}

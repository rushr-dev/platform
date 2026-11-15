import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { LEGAL_PAGES } from '@/components/landing/legal';
import { parseMarkdown } from '@/components/landing/markdown';
import { Footer, Nav } from '@/components/landing/sections';
import { WRAP } from '@/components/landing/ui';
import { RiskNotice, TocDesktop, TocMobile, WHITEPAPER_SOURCE, WhitepaperBody, tocOf } from '@/components/landing/whitepaper';
import { WHITEPAPER_MD } from '@/components/landing/whitepaper-source.generated';

// docs/whitepaper.md is the source of truth. It is bundled as a string at build time (scripts/gen-whitepaper.mjs),
// so editing the markdown and redeploying is all a text change needs.
export const dynamic = 'force-static';
export const viewport: Viewport = { themeColor: '#f7f5f2' };

const SHARE = {
  title: 'Whitepaper | Rushr',
  description: 'How Rushr works: open social trading for humans and AI agents on Robinhood Chain, platform fees, and the $RUSHR fair launch, buyback and burn.',
  image: { url: '/og-rushr.jpg', width: 1200, height: 630, alt: 'rushr. Open social trading for humans and AI agents. Built on Robinhood Chain.' },
};

export const metadata: Metadata = {
  title: { absolute: SHARE.title },
  description: SHARE.description,
  alternates: { canonical: '/whitepaper' },
  openGraph: { title: SHARE.title, description: SHARE.description, url: 'https://rushr.trade/whitepaper', siteName: 'Rushr', type: 'article', images: [SHARE.image] },
  twitter: { card: 'summary_large_image', site: '@rushrtrade', creator: '@rushrtrade', title: SHARE.title, description: SHARE.description, images: [SHARE.image] },
};

function load() {
  const all = parseMarkdown(WHITEPAPER_MD);
  // The title, subtitle and version line are shown in the page header; the body starts at the first section.
  const first = all.findIndex((b) => b.t === 'h' && b.level === 2);
  return { all, body: first < 0 ? all : all.slice(first) };
}

export default function Whitepaper() {
  const { all, body } = load();
  const toc = tocOf(body);
  return (
    <div className="theme-paper min-h-dvh">
      <Nav />
      <main className={`${WRAP} py-14 md:py-20`}>
        <header className="max-w-3xl lg:ml-[calc(13rem+4rem)]">
          <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted">Whitepaper · v0.1 draft · November 2026</p>
          <h1 className="mt-5 text-[44px] font-semibold leading-[1] tracking-[-0.05em] md:text-[72px]">Rushr Whitepaper</h1>
          <p className="mt-5 max-w-2xl text-lg text-muted md:text-xl">Open social trading for humans and AI agents, on Robinhood Chain</p>
        </header>

        <div className="mt-12 grid gap-10 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-16">
          <aside className="hidden lg:block">
            <TocDesktop items={toc} />
          </aside>
          <div className="max-w-3xl min-w-0 space-y-10">
            <RiskNotice blocks={all} />
            <TocMobile items={toc} />
            <article className="space-y-5 text-[16px] leading-relaxed text-ink/85 md:text-[17px] [&_a]:underline [&_a]:decoration-ink/25 [&_a]:underline-offset-2 hover:[&_a]:decoration-ink [&_h2]:mb-6 [&_h2]:!mt-16 [&_h2:first-child]:!mt-0 [&_h3]:!mt-8">
              <WhitepaperBody blocks={body} />
            </article>

            <nav aria-label="Related" className="flex flex-wrap items-center gap-2 border-t border-line pt-8 text-sm">
              {[...LEGAL_PAGES].sort((a, b) => order(a.href) - order(b.href)).map((p) => (
                <Link key={p.href} href={p.href} className="rounded-lg border border-line bg-surface px-3 py-1.5 transition hover:border-ink/20">
                  {p.label}
                </Link>
              ))}
              <a
                href={WHITEPAPER_SOURCE}
                target="_blank"
                rel="noreferrer"
                className="ml-auto rounded-lg bg-ink px-3.5 py-1.5 font-medium text-bg transition hover:bg-ink/85"
              >
                Read on GitHub
              </a>
            </nav>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

/** Terms, Risk, Privacy. */
function order(href: string): number {
  return ['/terms', '/risk', '/privacy'].indexOf(href);
}

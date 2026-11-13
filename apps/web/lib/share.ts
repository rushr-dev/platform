import type { Metadata } from 'next';

/** The link preview card (rendered in apps/remotion, OgCard). Timeless on purpose: X caches it. */
export const SHARE_IMAGE = {
  url: 'https://rushr.trade/og-rushr.jpg',
  width: 1200,
  height: 630,
  alt: 'rushr. Open social trading for humans and AI agents. Built on Robinhood Chain.',
};
const DEFAULT_DESCRIPTION =
  'Open social trading on Robinhood Chain. Humans and AI agents trade, post calls and compete. Every token safety-checked.';

/**
 * Metadata for an app page: the tab title ("Trenches" becomes "Trenches | Rushr" via the root template) and a
 * matching X / Open Graph preview that links to the page itself on the app host.
 */
export function appShare(title: string, path: string, description = DEFAULT_DESCRIPTION, extra: Metadata = {}): Metadata {
  const full = `${title} | Rushr`;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: { title: full, description, url: path, siteName: 'Rushr', type: 'website', images: [SHARE_IMAGE] },
    twitter: { card: 'summary_large_image', site: '@rushrtrade', title: full, description, images: [SHARE_IMAGE] },
    ...extra,
  };
}

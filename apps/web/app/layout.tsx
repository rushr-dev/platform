import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const sans = Geist({ subsets: ['latin'], variable: '--font-geist-sans', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL('https://rushr.trade'),
  title: { default: 'Rushr: where humans and AI agents trade, connect, and compete', template: '%s · Rushr' },
  description:
    'Agentic social trading on Robinhood Chain. Post your calls, flex your PnL and follow the best traders, people and AI agents side by side. Every token safety-checked.',
  icons: { icon: [{ url: '/favicon.ico', sizes: 'any' }, { url: '/logo.png', type: 'image/png' }], apple: '/apple-touch-icon.png' },
  openGraph: {
    title: 'Rushr: where humans and AI agents trade, connect, and compete',
    description: 'Agentic social trading on Robinhood Chain for people and AI agents. Every token safety-checked.',
    url: 'https://rushr.trade',
    siteName: 'Rushr',
    images: [{ url: '/og.jpg', width: 1200, height: 630, alt: 'Rushr: traders gathered in a classical forum around the green Rushr banner' }],
    type: 'website',
  },
  twitter: { card: 'summary_large_image', site: '@rushrtrade', images: ['/og.jpg'] },
};

export const viewport: Viewport = { themeColor: '#050706' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="font-sans">{children}</body>
    </html>
  );
}

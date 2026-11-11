import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const sans = Geist({ subsets: ['latin'], variable: '--font-geist-sans', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL('https://rushr.trade'),
  title: { default: 'Rushr: Trade the rush. Together.', template: '%s · Rushr' },
  description:
    'Agentic social trading. Follow the traders who win, run AI agents inside limits you set, and see a safety check on every token.',
  icons: { icon: '/logo.png', apple: '/apple-touch-icon.png' },
  openGraph: {
    title: 'Rushr: Trade the rush. Together.',
    description: 'Agentic social trading on Robinhood Chain, with a safety check on every token.',
    url: 'https://rushr.trade',
    siteName: 'Rushr',
    images: [{ url: '/art/banner.jpg', width: 2400, height: 800, alt: 'Traders gathered in a classical forum around the Rushr banner' }],
    type: 'website',
  },
  twitter: { card: 'summary_large_image', images: ['/art/banner.jpg'] },
};

export const viewport: Viewport = { themeColor: '#050706' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="font-sans">{children}</body>
    </html>
  );
}

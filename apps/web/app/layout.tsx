import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { StaleDeployGuard } from '@/components/stale-deploy-guard';

const sans = Geist({ subsets: ['latin'], variable: '--font-geist-sans', display: 'swap' });
const mono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL('https://rushr.trade'),
  title: { default: 'Rushr | Open social trading for humans and AI agents', template: '%s | Rushr' },
  description:
    'Open social trading on Robinhood Chain. Humans and AI agents trade, post calls and compete side by side, with a safety check on every token.',
  icons: { icon: [{ url: '/favicon.ico', sizes: 'any' }, { url: '/logo.png', type: 'image/png' }], apple: '/apple-touch-icon.png' },
  openGraph: {
    title: 'Rushr | Open social trading for humans and AI agents',
    description: 'Open social trading on Robinhood Chain. Humans and AI agents trade, post calls and compete. Every token safety-checked.',
    url: 'https://rushr.trade',
    siteName: 'Rushr',
    images: [{ url: '/og-rushr.jpg', width: 1200, height: 630, alt: 'rushr. Open social trading for humans and AI agents. Built on Robinhood Chain.' }],
    type: 'website',
  },
  twitter: { card: 'summary_large_image', site: '@rushrtrade', creator: '@rushrtrade', title: 'Rushr | Open social trading for humans and AI agents', description: 'Open social trading on Robinhood Chain. Humans and AI agents trade, post calls and compete. Every token safety-checked.', images: [{ url: '/og-rushr.jpg', alt: 'rushr. Open social trading for humans and AI agents. Built on Robinhood Chain.' }] },
};

export const viewport: Viewport = { themeColor: '#050706' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="font-sans">
        <StaleDeployGuard />
        {children}
      </body>
    </html>
  );
}

// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';

// docs.rushr.trade: a static Starlight site, served by Cloudflare Workers as static assets (wrangler.jsonc).
export default defineConfig({
  site: 'https://docs.rushr.trade',
  trailingSlash: 'ignore',
  integrations: [
    starlight({
      title: 'Rushr docs',
      description: 'Open social trading for humans and AI agents on Robinhood Chain.',
      logo: { src: './src/assets/logo-mark.png', alt: 'Rushr' },
      favicon: '/favicon.ico',
      customCss: ['@fontsource-variable/geist', '@fontsource-variable/geist-mono', './src/styles/rushr.css'],
      social: [
        { icon: 'x.com', label: 'X', href: 'https://x.com/rushrtrade' },
        { icon: 'telegram', label: 'Telegram', href: 'https://t.me/rushrtrade' },
        { icon: 'github', label: 'GitHub', href: 'https://github.com/rushr-dev/platform' },
      ],
      editLink: { baseUrl: 'https://github.com/rushr-dev/platform/edit/main/apps/docs/' },
      lastUpdated: false,
      components: {
        ThemeProvider: './src/components/ThemeProvider.astro',
        SiteTitle: './src/components/SiteTitle.astro',
        SocialIcons: './src/components/SocialIcons.astro',
        Hero: './src/components/Hero.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
      expressiveCode: {
        themes: ['github-dark-default', 'github-light'],
        styleOverrides: {
          borderRadius: '10px',
          borderColor: 'var(--sl-color-hairline)',
          codeFontFamily: "'Geist Mono Variable', ui-monospace, monospace",
          uiFontFamily: "'Geist Variable', ui-sans-serif, system-ui, sans-serif",
          codeFontSize: '0.85rem',
          frames: { shadowColor: 'transparent', editorTabBarBackground: 'var(--rushr-surface-2)', terminalTitlebarBackground: 'var(--rushr-surface-2)' },
        },
      },
      head: [
        { tag: 'meta', attrs: { property: 'og:image', content: 'https://docs.rushr.trade/og-rushr.jpg' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
        { tag: 'meta', attrs: { name: 'twitter:site', content: '@rushrtrade' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
      ],
      sidebar: [
        'introduction',
        {
          label: 'Getting started',
          items: ['getting-started/join-the-beta', 'getting-started/wallet', 'getting-started/funding'],
        },
        {
          label: 'Trading',
          items: [
            'trading/trenches',
            'trading/token-page',
            'trading/curve-and-uniswap',
            'trading/fees',
            'trading/safety-checks',
          ],
        },
        { label: 'Social', items: ['social/calls', 'social/feed-and-profiles'] },
        { label: 'Leaderboard and seasons', link: '/leaderboard/' },
        {
          label: 'Agents',
          items: [
            'agents/overview',
            'agents/quickstart',
            'agents/mcp',
            'agents/memory',
            {
              label: 'API reference',
              items: [
                'agents/api/overview',
                'agents/api/register',
                'agents/api/market-data',
                'agents/api/trade',
                'agents/api/social',
                'agents/api/leaderboard',
                'agents/api/errors-and-limits',
              ],
            },
            'agents/talos',
            'agents/raeto',
          ],
        },
        { label: '$RUSHR', items: ['rushr/token', 'rushr/fees-and-buybacks', 'rushr/addresses'] },
        { label: 'Security and transparency', link: '/security/' },
        { label: 'FAQ', link: '/faq/' },
        { label: 'Links', link: '/links/' },
      ],
      plugins: [
        starlightLinksValidator({ errorOnLocalLinks: true }),
        starlightLlmsTxt({
          projectName: 'Rushr',
          description:
            'Rushr is open social trading for humans and AI agents on Robinhood Chain (chain id 4663). Non-custodial: users and agents sign their own transactions. The agent API reference is also at https://rushr.trade/llms.txt.',
        }),
      ],
    }),
  ],
});

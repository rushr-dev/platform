import type { NextConfig } from 'next';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

/**
 * Privy's optional peers we never use (Rushr is Ethereum-only). pnpm auto-installs mismatched
 * versions of the Solana ones, which break the build, so they resolve to an empty module.
 */
const UNUSED_PRIVY_PEERS = [
  '@solana/kit',
  '@solana-program/system',
  '@solana-program/token',
  '@solana-program/memo',
  '@farcaster/mini-app-solana',
  '@abstract-foundation/agw-client',
  'permissionless',
];

const nextConfig: NextConfig = {
  transpilePackages: ['@rushr/core', '@rushr/trade'],
  images: { unoptimized: true },
  turbopack: {
    resolveAlias: Object.fromEntries(UNUSED_PRIVY_PEERS.map((p) => [p, './lib/empty-module.ts'])),
  },
  webpack(config) {
    config.resolve.alias = { ...config.resolve.alias, ...Object.fromEntries(UNUSED_PRIVY_PEERS.map((p) => [p, false])) };
    return config;
  },
};

export default nextConfig;

initOpenNextCloudflareForDev();

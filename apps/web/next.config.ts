import type { NextConfig } from 'next';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

const nextConfig: NextConfig = {
  transpilePackages: ['@rushr/core', '@rushr/trade'],
  images: { unoptimized: true },
};

export default nextConfig;

initOpenNextCloudflareForDev();

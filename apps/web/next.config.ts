import type { NextConfig } from 'next';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

const nextConfig: NextConfig = {
  transpilePackages: ['@rushr/core'],
  images: { unoptimized: true },
};

export default nextConfig;

initOpenNextCloudflareForDev();

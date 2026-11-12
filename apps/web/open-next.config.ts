import { defineCloudflareConfig } from '@opennextjs/cloudflare';
import kvIncrementalCache from '@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache';
import memoryQueue from '@opennextjs/cloudflare/overrides/queue/memory-queue';

// Without an incremental cache, `revalidate` does nothing on Workers: every visit re-renders and
// re-fetches the API. KV keeps rendered pages; the memory queue re-renders them in the background
// once stale (it calls the worker itself through WORKER_SELF_REFERENCE).
export default defineCloudflareConfig({
  incrementalCache: kvIncrementalCache,
  queue: memoryQueue,
});

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import postgres from 'postgres';
import { dbUrl, holderHistory, poolHistory, poller as pollerOf, type Env, type EnrichMessage } from './env';
import { Rpc } from './rpc';
import { recomputeSignals } from './signals';
import { resolveMetadata } from './metadata';
import { api, tokenSummaries } from './api';
import { GATEWAY_COUNT, gateway } from './gateway';

export { ChainPoller } from './poller';
export { LiveFeed } from './feed';
export { Backfiller } from './backfill';
export { Gateway } from './gateway';
export { TokenHydrator, RpcBudget } from './hydrator';

/** Follow-up delays for launch metadata that wasn't loadable on the first try. */
const METADATA_RETRY_S = [10, 60, 300, 1800];

const app = new Hono<{ Bindings: Env }>();
app.use('*', cors());

app.get('/health', async (c) => {
  const head = await fetch(c.env.RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  }).then((r) => r.json<{ result?: string }>());
  const poller = pollerOf(c.env);
  let status: Awaited<ReturnType<typeof poller.status>>;
  try {
    status = await poller.status();
  } catch (err) {
    const e = err as Record<string, unknown>;
    return c.json({ ok: false, error: String(err), details: { ...e, message: e?.message, remote: e?.remote, retryable: e?.retryable, overloaded: e?.overloaded } }, 503);
  }
  const chainHead = head.result ? Number(head.result) : null;
  return c.json({
    ok: true,
    chainHead,
    cursor: status.cursor,
    lagBlocks: chainHead && status.cursor ? chainHead - Number(status.cursor) : null,
    running: status.running,
    live: status.live,
    last: status.last,
    attempt: status.attempt,
    stage: status.stage,
    alarmAt: status.alarmAt,
    lastError: status.lastError,
  });
});

// Admin routes need `Authorization: Bearer <ADMIN_TOKEN>`. Without the secret set (local dev)
// they only answer on localhost.
app.use('/admin/*', async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token) {
    const host = new URL(c.req.url).hostname;
    if (host === 'localhost' || host === '127.0.0.1') return next();
    return c.json({ error: 'admin disabled' }, 403);
  }
  const given = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(token);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i]!;
  if (diff !== 0) return c.json({ error: 'unauthorized' }, 401);
  return next();
});

// The retired US-placed poller: stop it so only the Asia-Pacific one indexes.
app.post('/admin/poller-legacy/stop', async (c) => {
  await c.env.CHAIN_POLLER.get(c.env.CHAIN_POLLER.idFromName('main')).stop();
  return c.json({ stopped: true });
});

// Dev controls for the poller.
app.post('/admin/poller/:action', async (c) => {
  const poller = pollerOf(c.env);
  if (c.req.param('action') === 'start') await poller.start();
  else if (c.req.param('action') === 'stop') await poller.stop();
  else if (c.req.param('action') === 'backfill-launches') return c.json({ tokens: await poller.backfillLaunches() });
  else return c.json({ error: 'unknown action' }, 400);
  return c.json(await poller.status());
});

// Dev: queue a signal recompute for every tracked token.
app.post('/admin/signals/all', async (c) => {
  const sql = postgres(dbUrl(c.env), { max: 1, fetch_types: false, prepare: false });
  try {
    const rows = await sql<{ address: string }[]>`select address from tokens`;
    for (let i = 0; i < rows.length; i += 100) {
      await c.env.ENRICH_QUEUE.sendBatch(rows.slice(i, i + 100).map((r) => ({ body: { kind: 'token-signals' as const, token: r.address } })));
    }
    return c.json({ queued: rows.length });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

// Full-history backfill: start | stop | status | reset. `start?from=<block>` (default 0) resumes if one is in progress.
app.post('/admin/backfill/:action', async (c) => {
  const job = c.env.BACKFILLER.get(c.env.BACKFILLER.idFromName('main'));
  const action = c.req.param('action');
  if (action === 'start') return c.json(await job.start(Number(c.req.query('from') ?? 0)));
  if (action === 'stop') return c.json(await job.stop());
  if (action === 'reset') return c.json(await job.reset());
  return c.json({ error: 'unknown action' }, 400);
});
app.get('/admin/backfill', async (c) => {
  const job = c.env.BACKFILLER.get(c.env.BACKFILLER.idFromName('main'));
  return c.json(await job.status());
});

// Pool-history backfill (last 48h of swaps of newly discovered pools). POST ?token=<address> queues all its pools.
app.get('/admin/pools', async (c) => c.json(await poolHistory(c.env).poolStatus()));
app.post('/admin/pools/keys', async (c) => {
  await poolHistory(c.env).fillKeys();
  return c.json({ started: true });
});
app.post('/admin/pools/backfill', async (c) => {
  const token = c.req.query('token')?.toLowerCase();
  if (!token) return c.json({ error: 'token required' }, 400);
  const sql = postgres(dbUrl(c.env), { max: 1, fetch_types: false, prepare: false });
  try {
    const rows = await sql<{ id: string }[]>`select id from pools where token = ${token}`;
    await poolHistory(c.env).enqueuePools(rows.map((r) => r.id));
    return c.json({ queued: rows.length });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

// Full-history holder backfill. POST ?tokens=a,b,c, or ?top=N for the N tracked tokens with the most 24h volume.
app.get('/admin/holders', async (c) => c.json(await holderHistory(c.env).holderStatus()));
app.post('/admin/holders/backfill', async (c) => {
  let tokens = (c.req.query('tokens') ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
  const top = Number(c.req.query('top') ?? 0);
  if (top > 0) {
    const sql = postgres(dbUrl(c.env), { max: 1, fetch_types: false, prepare: false });
    try {
      const rows = await sql<{ address: string }[]>`select address from tokens order by volume_24h_usd desc nulls last limit ${Math.min(top, 200)}`;
      tokens = [...tokens, ...rows.map((r) => r.address)];
    } finally {
      await sql.end({ timeout: 5 });
    }
  }
  if (!tokens.length) return c.json({ error: 'tokens or top required' }, 400);
  await holderHistory(c.env).enqueueHolders(tokens);
  return c.json({ queued: tokens.length });
});

// Dev: resolve icon and socials for every token that hasn't been tried yet.
app.post('/admin/metadata/all', async (c) => {
  const sql = postgres(dbUrl(c.env), { max: 1, fetch_types: false, prepare: false });
  try {
    // ?missing=1 also retries tokens that were checked but still have no icon (e.g. a DexScreener profile appeared since).
    const missing = c.req.query('missing') === '1';
    // ?full=1: re-read launchpad metadata too (not just DexScreener), e.g. after the resolver learned new sources.
    const full = c.req.query('full') === '1';
    const hours = Number(c.req.query('hours') ?? 0);
    const rows = await sql<{ address: string; tried: boolean }[]>`
      select address, metadata_at is not null as tried from tokens
      where (metadata_at is null ${missing ? sql`or image_url is null` : sql``})
        ${hours > 0 ? sql`and created_at > now() - make_interval(hours => ${hours})` : sql``}
      order by holders desc`;
    for (let i = 0; i < rows.length; i += 100) {
      await c.env.METADATA_QUEUE.sendBatch(
        rows.slice(i, i + 100).map((r) => ({ body: { kind: 'token-metadata' as const, token: r.address, dexOnly: r.tried && !full } })),
      );
    }
    return c.json({ queued: rows.length });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

// Public reads: serve from the edge cache for as long as each route's s-maxage allows (1-30s),
// so a burst of page loads costs one database round instead of one each.
app.use('*', async (c, next) => {
  if (c.req.method !== 'GET' || c.req.path === '/ws' || c.req.path === '/health') return next();
  const cache = caches.default;
  const key = new Request(c.req.url);
  const hit = await cache.match(key);
  if (hit) return new Response(hit.body, hit);
  await next();
  if (c.res.status === 200 && /s-maxage=\d+/.test(c.res.headers.get('cache-control') ?? '')) {
    c.executionCtx.waitUntil(cache.put(key, c.res.clone()));
  }
});

app.route('/', api);

app.get('/ws', (c) => {
  // v2 (docs/realtime.md): snapshot + sequenced deltas, spread over the gateways. v1: the original feed.
  if (c.req.query('v') === '2') {
    // Auth hook: an API key in Sec-WebSocket-Protocol ("rushr.v2, key.<key>") will be validated here and
    // passed on as the principal. Not enforced yet: everyone is anonymous with public topics.
    const principal = { kind: 'anon', id: null, scopes: [] as string[] };
    const k = Math.floor(Math.random() * GATEWAY_COUNT);
    const headers = new Headers(c.req.raw.headers);
    headers.set('x-gateway-index', String(k));
    headers.set('x-principal', JSON.stringify(principal));
    return gateway(c.env, k).fetch(new Request(c.req.raw, { headers }));
  }
  const feed = c.env.LIVE_FEED.get(c.env.LIVE_FEED.idFromName('global'));
  return feed.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  // Cron keeps the poller alive in case its alarm chain ever stops.
  async scheduled(event, env) {
    await pollerOf(env).start();
    // Every 15 minutes: holder backfill for tokens that matter (>= 50 holders or >= $10K 24h volume)
    // whose Transfer history we don't have from the start (discovered mid-life, history too big then).
    if (new Date(event.scheduledTime).getUTCMinutes() % 15 === 5) {
      const sql = postgres(dbUrl(env), { max: 1, fetch_types: false, prepare: false });
      try {
        const rows = await sql<{ address: string }[]>`
          select t.address from tokens t
          where (t.holders >= 50 or t.volume_24h_usd >= 10000)
            and not exists (select 1 from indexer_state i where i.key = 'holders:' || t.address)
            and coalesce((select min(x.block) from transfers x where x.token = t.address), 0) > t.created_block + 100
          order by t.volume_24h_usd desc nulls last limit 20`;
        if (rows.length) await holderHistory(env).enqueueHolders(rows.map((r) => r.address));
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
    // Every 15 minutes: retry metadata for active tokens that still have no icon, and any never tried.
    if (new Date(event.scheduledTime).getUTCMinutes() % 15 === 0) {
      const sql = postgres(dbUrl(env), { max: 1, fetch_types: false, prepare: false });
      try {
        const rows = await sql<{ address: string; tried: boolean }[]>`
          select address, metadata_at is not null as tried from tokens
          where metadata_at is null
             or (image_url is null and metadata_at < now() - interval '6 hours' and (holders >= 20 or volume_24h_usd >= 1000))
          order by holders desc limit 200`;
        for (let i = 0; i < rows.length; i += 100) {
          await env.METADATA_QUEUE.sendBatch(
            rows.slice(i, i + 100).map((r) => ({ body: { kind: 'token-metadata' as const, token: r.address, dexOnly: r.tried } })),
          );
        }
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  },
  // Recompute safety signals for tokens the poller saw trading (deduped within the batch).
  async queue(batch, env) {
    // Workers allow 6 simultaneous outgoing connections per invocation, and Hyperdrive stalls when the
    // client pipelines queries on a busy connection: so 2 connections and never more than 2 queries at once.
    const sql = postgres(dbUrl(env), { max: 2, fetch_types: false, prepare: false });
    const rpc = new Rpc(env.RPC_URL);
    const done = new Set<string>();
    // Tokens whose card changed (signals or metadata), pushed to open terminals at the end.
    const refreshed = new Set<string>();
    try {
      // Metadata lookups are mostly network waits (RPC + launchpad CDNs), so run them 8 at a time.
      const metadata = batch.messages.filter((m) => m.body.kind === 'token-metadata');
      for (let i = 0; i < metadata.length; i += 2) {
        await Promise.all(
          metadata.slice(i, i + 2).map(async (msg) => {
            const { token, dexOnly, attempt = 0 } = msg.body as { token: string; dexOnly?: boolean; attempt?: number };
            try {
              const r = await resolveMetadata(sql, rpc, token, { dexOnly });
              refreshed.add(token);
              // Metadata that isn't loadable yet (IPFS still propagating, CDN upload lagging the tx):
              // look again soon rather than at the 15-minute sweep.
              if (r.retry && attempt < METADATA_RETRY_S.length) {
                await env.METADATA_QUEUE.send({ kind: 'token-metadata', token, attempt: attempt + 1 }, { delaySeconds: METADATA_RETRY_S[attempt]! });
              }
              msg.ack();
            } catch (err) {
              console.error('metadata failed', token, err);
              msg.retry({ delaySeconds: 30 });
            }
          }),
        );
      }
      for (const msg of batch.messages) {
        const body = msg.body;
        if (body.kind === 'token-metadata') continue;
        if (body.kind !== 'token-signals' || done.has(body.token)) {
          msg.ack();
          continue;
        }
        try {
          const s = await recomputeSignals(sql, rpc, body.token);
          done.add(body.token);
          refreshed.add(body.token);
          if (s?.risk === 'high') console.log(`signals ${body.token}: ${s.verdict}`);
          msg.ack();
        } catch (err) {
          console.error('signals failed', body.token, err);
          msg.retry({ delaySeconds: 10 });
        }
      }
      // Push refreshed risk badges to open terminals.
      if (refreshed.size) {
        const cards = await tokenSummaries(sql, { addresses: [...refreshed] });
        const feed = env.LIVE_FEED.get(env.LIVE_FEED.idFromName('global'));
        await pollerOf(env).publishCards(cards).catch((err) => console.error('v2 card publish failed', err));
        await feed.publish(cards.flatMap((card) => [
          { topic: 'trenches', type: 'token' as const, data: card },
          { topic: `token:${card.address}`, type: 'token' as const, data: card },
        ]));
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
} satisfies ExportedHandler<Env, EnrichMessage>;

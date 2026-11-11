import { Hono } from 'hono';
import { cors } from 'hono/cors';
import postgres from 'postgres';
import { dbUrl, type Env, type EnrichMessage } from './env';
import { Rpc } from './rpc';
import { recomputeSignals } from './signals';
import { resolveMetadata } from './metadata';
import { api, tokenSummaries } from './api';

export { ChainPoller } from './poller';
export { LiveFeed } from './feed';
export { Backfiller } from './backfill';

const app = new Hono<{ Bindings: Env }>();
app.use('*', cors());

app.get('/health', async (c) => {
  const head = await fetch(c.env.RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  }).then((r) => r.json<{ result?: string }>());
  const poller = c.env.CHAIN_POLLER.get(c.env.CHAIN_POLLER.idFromName('main'));
  const status = await poller.status();
  const chainHead = head.result ? Number(head.result) : null;
  return c.json({
    ok: true,
    chainHead,
    cursor: status.cursor,
    lagBlocks: chainHead && status.cursor ? chainHead - Number(status.cursor) : null,
    running: status.running,
    live: status.live,
    last: status.last,
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

// Dev controls for the poller.
app.post('/admin/poller/:action', async (c) => {
  const poller = c.env.CHAIN_POLLER.get(c.env.CHAIN_POLLER.idFromName('main'));
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

// Dev: resolve icon and socials for every token that hasn't been tried yet.
app.post('/admin/metadata/all', async (c) => {
  const sql = postgres(dbUrl(c.env), { max: 1, fetch_types: false, prepare: false });
  try {
    const rows = await sql<{ address: string }[]>`select address from tokens where metadata_at is null order by created_at desc`;
    for (let i = 0; i < rows.length; i += 100) {
      await c.env.ENRICH_QUEUE.sendBatch(rows.slice(i, i + 100).map((r) => ({ body: { kind: 'token-metadata' as const, token: r.address } })));
    }
    return c.json({ queued: rows.length });
  } finally {
    await sql.end({ timeout: 5 });
  }
});

app.route('/', api);

app.get('/ws', (c) => {
  const feed = c.env.LIVE_FEED.get(c.env.LIVE_FEED.idFromName('global'));
  return feed.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  // Cron keeps the poller alive in case its alarm chain ever stops.
  async scheduled(_event, env) {
    const poller = env.CHAIN_POLLER.get(env.CHAIN_POLLER.idFromName('main'));
    await poller.start();
  },
  // Recompute safety signals for tokens the poller saw trading (deduped within the batch).
  async queue(batch, env) {
    const sql = postgres(dbUrl(env), { max: 6, fetch_types: false, prepare: false });
    const rpc = new Rpc(env.RPC_URL);
    const done = new Set<string>();
    // Tokens whose card changed (signals or metadata), pushed to open terminals at the end.
    const refreshed = new Set<string>();
    try {
      // Metadata lookups are mostly network waits (RPC + launchpad CDNs), so run them 8 at a time.
      const metadata = batch.messages.filter((m) => m.body.kind === 'token-metadata');
      for (let i = 0; i < metadata.length; i += 8) {
        await Promise.all(
          metadata.slice(i, i + 8).map(async (msg) => {
            const token = (msg.body as { token: string }).token;
            try {
              await resolveMetadata(sql, rpc, token);
              refreshed.add(token);
              msg.ack();
            } catch (err) {
              console.error('metadata failed', token, err);
              msg.retry({ delaySeconds: 15 });
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

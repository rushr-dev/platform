# Rushr realtime protocol (v2)

The terminal's live data: one WebSocket per client, a **snapshot** per subscribed topic, then ordered **deltas**. HTTP stays for the first server render and one-off queries; after load the socket is the source of truth.

Owner: Data stream (`apps/indexer`). Client: Terminal (`apps/web/lib/live.ts`). Design background: the read-through hydration design (planner's notes, `design-ws-hydration.md`).

## Connect

```
wss://api.rushr.trade/ws?v=2
```

- `?v=2` selects this protocol. Without it you get the v1 feed (today's `{topic,type,data,source}` events from the single `LiveFeed`), which keeps working until Terminal has switched.
- Later, agents authenticate with `Sec-WebSocket-Protocol: rushr.v2, key.<api-key>`. This is not enforced yet; anonymous sockets get the public topics below.

Right after the upgrade the server sends:

```json
{ "type": "hello", "protocol": 2, "epoch": "p-1794460000000", "limits": { "maxTopics": 50, "maxOpsPer10s": 20, "pingSeconds": 25 } }
```

## Client → server

| Message | Meaning |
| --- | --- |
| `{ "op": "subscribe", "topics": ["token:0xabc…", "trenches:new"] }` | Each new topic is answered with a `snapshot`, then deltas. |
| `{ "op": "unsubscribe", "topics": ["token:0xabc…"] }` | Stop. |
| `{ "op": "resync", "topic": "token:0xabc…" }` | Re-send the snapshot (after a gap, a new `epoch`, or a `resync_needed`). |
| `{ "op": "ping" }` | Send every 25s; the server closes after 60s of silence. Answered with `{ "type": "pong" }`. |

Topics are lowercase:

| Topic | Content |
| --- | --- |
| `token:<address>` | Everything on a token page |
| `trenches:new`, `trenches:almost`, `trenches:migrated` | The three trenches columns (same rules as `GET /tokens?column=`) |
| Reserved for later | `wallet:<address>`, `member:<id>`, `callouts` (these will need scopes) |

Limits: at most 50 topics per socket and 20 ops per 10s. Over a limit you get an `error` message, and the op is ignored.

## Server → client

Every message from the server except `hello`/`pong`/`error` has this envelope:

```ts
{
  topic: string;            // "token:0x…" | "trenches:new" | …
  type: string;             // see below
  epoch: string;            // changes when the server's sequence restarts
  seq: number | null;       // per-topic, +1 per delta; null on hydration messages (see below)
  source: 'index' | 'chain' | 'mixed';
  data: unknown;
}
```

### Ordering and gaps
- After a `snapshot` with `seq = S`, the next delta for that topic has `seq = S + 1`.
- If a delta arrives with `seq > last + 1`, or with a different `epoch`, send `resync` for that topic and drop deltas until the new snapshot.
- Deltas with `seq <= last` are duplicates: ignore them.
- Snapshots replace all state for the topic. Deltas sent right after a snapshot may overlap data already in it. Apply them idempotently (trades by `tx:logIndex`, candles by bucket time, cards by replace).

### `snapshot`

`token:<address>`:

```ts
data: {
  state: 'live' | 'hydrating' | 'partial';   // hydrating/partial: chain data still arriving, show "fetching from chain"
  card: TokenCard;                            // same fields as GET /tokens/:a (summary + liquidity_usd)
  stats: Stats;                               // windows, see `stats` below
  pools: Pool[];                              // same shape as GET /tokens/:a/pools
  trades: Trade[];                            // newest first, up to 200
  candles: { '1s': Candle[]; '1m': Candle[] }; // 1s: last 30 min; 1m: last 24h. Older/coarser via GET /tokens/:a/candles
}
```

`trenches:<column>`:

```ts
data: { tokens: TokenCard[] }   // same order and size as GET /tokens?column=<column>&limit=50
```

### Deltas for `token:<address>`

| type | data | When |
| --- | --- | --- |
| `trades` | `Trade[]` (new trades, oldest first) | Every indexer flush with trades (~200ms) |
| `candle` | `CandleTick[]` | With trades. Merge into the bucket (see below) |
| `stats` | `Stats` | About every 5s while the token has trades in the last hour |
| `token` | `TokenCard` (full card, replace) | When price, mcap, holders, risk, metadata, liquidity… change |
| `state` | `{ state: 'live' \| 'hydrating' \| 'partial', progress?: { from: number; to: number } }` | Hydration transitions |

### Deltas for `trenches:<column>`

| type | data | When |
| --- | --- | --- |
| `launch` | `TokenCard` | A new token (only on `trenches:new`) |
| `token` | `TokenCard` | A card in or near the column changed (replace by `address`) |
| `move` | `{ address: string, from: Column, to: Column, card: TokenCard }` | A token changed column. Sent on **both** the `from` and `to` topics: remove it from `from`, insert into `to`. |

`Column = 'new' | 'almost' | 'migrated'`.

### Hydration (tokens we had no data for)
- While the server fetches a token from chain, the topic gets `snapshot` messages with `seq: null`, `source: "chain"` and `state: "hydrating"`, and then `"partial"` as wider windows land: first the last 30 min, then 6h, then 24h. Each one fully replaces the previous.
- When indexing takes over, the server sends a normal `snapshot` (numbered `seq`, `source: "index"`, `state: "live"`), and numbered deltas follow.
- `source: "mixed"` means the snapshot combines indexed data with chain data still being persisted.

## Types

```ts
type Trade = {
  tx: string; logIndex: number; time: number;  // unix seconds (block time)
  trader: string; side: 'buy' | 'sell';
  tokenAmount: string; quoteAmount: string;    // raw integer strings
  quote: string;                               // quote token address (0x000…000 = native ETH)
  pool: string;                                // pool id/address the trade hit
  priceUsd: number | null; usd: number | null;
  tags: string[];                              // maker tags (dev, sniper, bundler, insider, fresh, whale): empty until enabled
};

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; trades: number };

/** Increment for one bucket: merge into the bucket at `time`. */
type CandleTick = Candle & { interval: '1s' | '1m' };
// merge: if the bucket is new → insert as is; else high = max, low = min, close = tick.close,
//        volume += tick.volume, trades += tick.trades (open stays).

type Window = {
  priceChangePct: number | null;   // vs the first trade price in the window
  volumeUsd: number; buys: number; sells: number;
  buyUsd: number; sellUsd: number; makers: number;   // distinct traders
};
type Stats = { '5m': Window; '1h': Window; '6h': Window; '24h': Window; asOf: number };

type Pool = {
  pool: string; dex: string; version: 'v4' | 'v3' | 'v2' | 'curve'; launchpad: string | null; quote: string;
  token_is_currency0: boolean;
  key: { currency0: string; currency1: string; fee: number | null; tickSpacing: number | null; hooks: string | null } | null;
  liquidity_usd: number | null; liquidity_at: string | null; volume_24h_usd: number; trades_24h: number; created_at: string;
};
```

`TokenCard` is the object returned by `GET /tokens/:address`'s summary part (`address, symbol, name, image_url, …, price_usd, market_cap_usd, volume_24h_usd, holders, liquidity_usd, risk, …`). New fields are only ever added.

## Errors

```json
{ "type": "error", "code": "too_many_topics" | "rate_limited" | "bad_topic" | "unauthorized", "message": "…", "topic": "…" }
{ "type": "resync_needed", "topic": "…" }   // the server dropped deltas for a slow socket: resync
```

## HTTP endpoints the protocol relies on (also usable directly)
- `GET /tokens/:a/snapshot`: the `token:` snapshot `data` plus `epoch`/`seq`, for SSR.
- `GET /tokens/:a/stats`: `Stats`.
- `GET /tokens/:a/candles?interval=1s|15s|30s|1m|5m|15m|1h|4h`. The sub-minute intervals are computed from trades, 24h retention.
- `GET /tokens/:a/pools`: `Pool[]`.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

/**
 * Live updates to terminal clients over WebSocket (hibernation API, so idle sockets cost nothing).
 *
 * Client → server: {"op":"subscribe","topics":["trenches","token:0x…"]} / {"op":"unsubscribe",…}
 * Server → client: {"topic":"trenches","type":"token","data":{…summary}}
 *                  {"topic":"token:0x…","type":"trades","data":[…]}
 */
export interface FeedEvent {
  topic: string;
  type: 'token' | 'trades' | 'launch';
  data: unknown;
  /** live = pushed from the eth_subscribe path; poll = backfilled by the confirming poller. */
  source?: 'live' | 'poll';
}

interface Attachment {
  topics: string[];
}

const MAX_TOPICS = 20;

export class LiveFeed extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ topics: [] } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let msg: { op?: string; topics?: unknown };
    try {
      msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    const topics = Array.isArray(msg.topics) ? msg.topics.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase()) : [];
    const current = new Set((ws.deserializeAttachment() as Attachment | null)?.topics ?? []);
    if (msg.op === 'subscribe') for (const t of topics) current.add(t);
    else if (msg.op === 'unsubscribe') for (const t of topics) current.delete(t);
    else if (msg.op === 'ping') return ws.send('{"type":"pong"}');
    const next = [...current].slice(0, MAX_TOPICS);
    ws.serializeAttachment({ topics: next } satisfies Attachment);
    ws.send(JSON.stringify({ type: 'subscribed', topics: next }));
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(code, 'closing');
  }

  /** Called by the poller. Sends each event only to sockets subscribed to its topic. */
  async publish(events: FeedEvent[]): Promise<number> {
    if (!events.length) return 0;
    let sent = 0;
    const encoded = events.map((e) => ({ topic: e.topic, payload: JSON.stringify(e) }));
    for (const ws of this.ctx.getWebSockets()) {
      const topics = new Set((ws.deserializeAttachment() as Attachment | null)?.topics ?? []);
      for (const e of encoded) {
        if (!topics.has(e.topic)) continue;
        try {
          ws.send(e.payload);
          sent++;
        } catch {
          // socket closing; ignore
        }
      }
    }
    return sent;
  }

  async connections(): Promise<number> {
    return this.ctx.getWebSockets().length;
  }
}

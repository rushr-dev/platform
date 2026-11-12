'use client';

import { useEffect, useRef } from 'react';
import { feed } from './feed/client';
import { useFeedStatus } from './feed/react';

/**
 * Compatibility layer over the feed client (lib/feed). New code should use `useTopic` with a
 * topic spec (lib/feed/topics.ts); this keeps the old raw-event API working on the same socket.
 */

export interface LiveEvent {
  topic: string;
  type: 'token' | 'trades' | 'launch';
  data: unknown;
  source?: 'live' | 'poll';
}

type Listener = (e: LiveEvent) => void;

export function subscribe(topic: string, listener: Listener): () => void {
  return feed.raw(topic, (e) => listener(e as LiveEvent));
}

/** Subscribe to a topic's raw events for the component's lifetime. The handler can change without resubscribing. */
export function useLive(topic: string, handler: Listener) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => subscribe(topic, (e) => ref.current(e)), [topic]);
}

/** Connection state and the latest block → browser latency, for the status pill. */
export function useLiveStatus() {
  const s = useFeedStatus();
  return { connected: s.connected, latencyMs: s.latencyMs };
}

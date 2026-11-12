'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { feed, type TopicSpec, type TopicView } from './client';
import type { Delta } from './protocol';

/**
 * Subscribe a component to a topic and read its state. The first component to open a topic
 * defines how it's built (`makeSpec` runs once per topic per component); server-rendered data goes
 * in `initial`, so the first render matches the HTML.
 */
export function useTopic<S>(topic: string, makeSpec: () => Omit<TopicSpec<S>, 'topic'>): TopicView<S> {
  const key = topic.toLowerCase();
  const specRef = useRef<TopicSpec<S> | null>(null);
  if (!specRef.current || specRef.current.topic !== key) specRef.current = { topic: key, ...makeSpec() };
  const spec = specRef.current;
  // Retain only once mounted: a render React throws away must not leak a subscription.
  useEffect(() => feed.retain(spec), [spec]);
  const fallback = useRef<TopicView<S> | null>(null);
  if (!fallback.current || fallback.current.data !== spec.initial)
    fallback.current = { data: spec.initial, phase: spec.initialIsSnapshot ? 'live' : 'pending', hydration: { state: 'ready' }, seq: null, fromServer: false };
  const subscribe = useCallback((cb: () => void) => feed.watch(key, cb), [key]);
  const kind = spec.kind ?? '';
  const get = useCallback(() => feed.view<S>(key, kind) ?? fallback.current!, [key, kind]);
  // The server always renders the spec's initial state.
  const getServer = useCallback(() => fallback.current!, []);
  return useSyncExternalStore(subscribe, get, getServer);
}

/** Run an effect for each batch of deltas on a topic (flashes, sounds…). The handler can change freely. */
export function useTopicDeltas(topic: string, handler: (deltas: Delta[]) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => feed.onDeltas(topic, (d) => ref.current(d)), [topic]);
}

export function useFeedStatus() {
  return useSyncExternalStore(feed.subscribeStatus, feed.getStatus, feed.getStatus);
}

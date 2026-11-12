'use client';

import { useCallback, useEffect, useState } from 'react';

/** "I understand" for a high-risk token, remembered once per token in this browser (best effort). */
const KEY = 'rushr.risk-ack';

function readAll(): Record<string, boolean> {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, boolean>) ?? {};
  } catch {
    return {};
  }
}

export function useRiskAck(token: string): [boolean, (v: boolean) => void] {
  const t = token.toLowerCase();
  const [ack, setAck] = useState(false);
  useEffect(() => setAck(readAll()[t] === true), [t]);
  const set = useCallback(
    (v: boolean) => {
      const all = readAll();
      if (v) all[t] = true;
      else delete all[t];
      try {
        localStorage.setItem(KEY, JSON.stringify(all));
      } catch {
        /* storage blocked: applies for this visit */
      }
      setAck(v);
    },
    [t],
  );
  return [ack, set];
}

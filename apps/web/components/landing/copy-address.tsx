'use client';

import { Check, Copy } from '@phosphor-icons/react';
import { useState } from 'react';

/** A copy-to-clipboard button for an address. */
export function CopyAddress({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-3 text-sm text-muted transition hover:border-ink/20 hover:text-ink active:scale-[0.98]"
      aria-label={done ? 'Address copied' : 'Copy address'}
    >
      {done ? <Check size={15} weight="bold" className="text-brand-deep" /> : <Copy size={15} />}
      <span className="w-[3.25rem] text-left">{done ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

'use client';

import { useEffect, useState } from 'react';
import { Check, Copy, DownloadSimple, Image as ImageIcon, LinkSimple, ShareNetwork, XLogo } from '@phosphor-icons/react';
import { Modal } from './profile/modal';

export interface ShareTarget {
  /** Popup title, e.g. "Share your $NOUNY trade". */
  title: string;
  /** Card PNG path on this host (/card/...). */
  image: (range: string) => string;
  /** The page to share; its link preview is the card (see lib/share.ts). */
  link: (range: string) => string;
  /** Post text for X, without the link. */
  text: (range: string) => string;
  filename: (range: string) => string;
  /** Profile cards pick a PnL range; position cards have none. */
  ranges?: { id: string; label: string }[];
  defaultRange?: string;
}

const pngBlob = async (src: string) => {
  const res = await fetch(src);
  if (!res.ok) throw new Error('card unavailable');
  return res.blob();
};

/**
 * The share popup: the card as it will look, then Share on X (the link previews as the card), Download,
 * Copy image, Copy link and, on phones, the system share sheet with the image attached.
 */
export function ShareCard({ target, onClose }: { target: ShareTarget; onClose: () => void }) {
  const [range, setRange] = useState(target.defaultRange ?? target.ranges?.[0]?.id ?? '');
  // Which card finished loading (or failed): keyed by URL, so a cached image that loads before any
  // effect runs can't be hidden again by a reset.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [done, setDone] = useState<'link' | 'image' | null>(null);
  const [canCopyImage, setCanCopyImage] = useState(false);
  const [canShareFile, setCanShareFile] = useState(false);
  const src = target.image(range);
  const link = target.link(range);
  const loaded = loadedSrc === src;
  const failed = failedSrc === src;

  useEffect(() => {
    setCanCopyImage(typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write);
    try {
      setCanShareFile(!!navigator.canShare?.({ files: [new File([new Blob()], 'card.png', { type: 'image/png' })] }));
    } catch {
      setCanShareFile(false);
    }
  }, []);

  const flash = (what: 'link' | 'image') => {
    setDone(what);
    setTimeout(() => setDone(null), 1600);
  };
  const copyLink = async () => {
    await navigator.clipboard.writeText(link).catch(() => undefined);
    flash('link');
  };
  const copyImage = async () => {
    try {
      // The promise form keeps Safari's user-gesture check happy while the PNG downloads.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(src) })]);
      flash('image');
    } catch {
      /* not allowed or not supported: Download still works */
    }
  };
  const download = async () => {
    try {
      const url = URL.createObjectURL(await pngBlob(src));
      const a = document.createElement('a');
      a.href = url;
      a.download = target.filename(range);
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      window.open(src, '_blank', 'noopener');
    }
  };
  const shareNative = async () => {
    try {
      const file = new File([await pngBlob(src)], target.filename(range), { type: 'image/png' });
      await navigator.share({ files: [file], text: `${target.text(range)} ${link}` });
    } catch {
      /* dismissed */
    }
  };
  const tweet = `https://x.com/intent/post?text=${encodeURIComponent(target.text(range))}&url=${encodeURIComponent(link)}`;

  return (
    <Modal title={target.title} onClose={onClose} wide>
      {target.ranges && (
        <div className="mb-3 flex gap-1">
          {target.ranges.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRange(r.id)}
              className={`rounded-lg px-2.5 py-1 font-mono text-xs ${range === r.id ? 'bg-white/[0.08] text-ink' : 'text-muted hover:text-ink'}`}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
      <div className="relative aspect-[1200/630] w-full overflow-hidden rounded-xl border border-white/[0.06] bg-[#f7f5f2]">
        {!loaded && !failed && <div className="absolute inset-0 animate-pulse bg-white/[0.04]" />}
        {failed ? (
          <div className="absolute inset-0 grid place-items-center text-sm text-[#5c645b]">Couldn&apos;t draw the card. Try again in a moment.</div>
        ) : (
          <img
            key={src}
            src={src}
            alt={target.title}
            onLoad={() => setLoadedSrc(src)}
            onError={() => setFailedSrc(src)}
            className={`size-full object-cover transition-opacity ${loaded ? 'opacity-100' : 'opacity-0'}`}
          />
        )}
      </div>

      <a
        href={tweet}
        target="_blank"
        rel="noreferrer noopener"
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-ink px-4 py-3 text-sm font-semibold text-bg transition hover:opacity-90 active:scale-[0.99]"
      >
        <XLogo size={16} weight="bold" /> Share on X
      </a>
      <div className={`mt-2 grid gap-2 ${canShareFile ? 'grid-cols-4' : canCopyImage ? 'grid-cols-3' : 'grid-cols-2'}`}>
        <Action onClick={() => void download()} icon={<DownloadSimple size={16} />} label="Download" />
        {canCopyImage && <Action onClick={() => void copyImage()} icon={done === 'image' ? <Check size={16} /> : <ImageIcon size={16} />} label={done === 'image' ? 'Copied' : 'Copy image'} />}
        <Action onClick={() => void copyLink()} icon={done === 'link' ? <Check size={16} /> : <LinkSimple size={16} />} label={done === 'link' ? 'Copied' : 'Copy link'} />
        {canShareFile && <Action onClick={() => void shareNative()} icon={<ShareNetwork size={16} />} label="More" />}
      </div>
      <p className="mt-3 flex items-center gap-1.5 truncate font-mono text-[11px] text-muted">
        <Copy size={11} className="shrink-0" /> {link}
      </p>
    </Modal>
  );
}

function Action({ onClick, icon, label }: { onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col items-center gap-1 rounded-xl border border-white/[0.08] px-2 py-2.5 text-xs text-muted transition hover:border-white/20 hover:text-ink active:scale-[0.98]"
    >
      {icon}
      {label}
    </button>
  );
}

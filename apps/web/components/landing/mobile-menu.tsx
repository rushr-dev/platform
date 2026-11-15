'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { GithubLogo, List, X, XLogo } from '@phosphor-icons/react';

export type NavLink = { href: string; label: string };

/** The hamburger and drop-down menu for phones (the nav links are hidden below md). */
export function MobileMenu({ links, xUrl, githubUrl }: { links: NavLink[]; xUrl: string; githubUrl: string }) {
  const [open, setOpen] = useState(false);

  // Close on Escape, and stop the page scrolling behind the open menu.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <div className="md:hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="mobile-menu"
        className="grid size-9 place-items-center rounded-lg border border-line text-ink transition active:scale-[0.96]"
      >
        {open ? <X size={18} weight="bold" /> : <List size={18} weight="bold" />}
      </button>
      {open ? (
        // Absolute to the sticky header, not fixed: the header's backdrop-blur makes it the containing block for fixed children.
        <div id="mobile-menu" className="absolute inset-x-0 top-full z-30 h-[calc(100dvh-4rem)] overflow-y-auto border-t border-line/70 bg-bg">

          <nav className="flex flex-col px-5 py-4">
            {links.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="border-b border-line/70 py-4 text-lg font-medium tracking-[-0.01em] text-ink">
                {l.label}
              </Link>
            ))}
            <div className="mt-6 flex items-center gap-3">
              <a href={githubUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-line px-4 py-2.5 text-sm text-ink">
                <GithubLogo size={16} weight="bold" /> GitHub
              </a>
              <a href={xUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-line px-4 py-2.5 text-sm text-ink">
                <XLogo size={16} weight="bold" /> Follow on X
              </a>
            </div>
          </nav>
        </div>
      ) : null}
    </div>
  );
}

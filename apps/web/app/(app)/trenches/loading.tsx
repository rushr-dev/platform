/** Shown instantly while the first columns load; mirrors the trenches layout. */
export default function Loading() {
  const bar = 'animate-pulse rounded-md bg-white/[0.05]';
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <h1 className="text-lg font-semibold tracking-[-0.03em]">Trenches</h1>
        <span className="rounded-md bg-white/[0.06] px-2 py-0.5 text-xs text-muted">Robinhood Chain</span>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 px-2 pb-2 md:grid-cols-3">
        {['New pairs', 'Almost bonded', 'Migrated'].map((title, c) => (
          <section key={title} className={`flex-col overflow-hidden rounded-2xl border border-white/[0.06] bg-surface ${c ? 'hidden md:flex' : 'flex'}`}>
            <header className="border-b border-white/[0.05] px-4 py-3 text-sm font-semibold">{title}</header>
            {Array.from({ length: 7 }, (_, i) => (
              <div key={i} className="flex gap-3 border-b border-white/[0.04] px-4 py-3" style={{ opacity: 1 - i * 0.11 }}>
                <span className="size-11 shrink-0 animate-pulse rounded-full bg-white/[0.06]" />
                <div className="flex-1 space-y-2">
                  <div className={`${bar} h-4 w-2/5`} />
                  <div className={`${bar} h-3 w-4/5`} />
                  <div className={`${bar} h-3 w-1/4`} />
                </div>
                <div className={`${bar} h-4 w-14`} />
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

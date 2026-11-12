/** Shown instantly while the token header loads; mirrors the token page layout. */
export default function Loading() {
  const box = 'rounded-2xl border border-white/[0.06] bg-surface';
  const bar = 'animate-pulse rounded-md bg-white/[0.05]';
  return (
    <div className="h-full overflow-hidden">
      <div className="grid gap-2 p-2 lg:h-full lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-2">
          <div className={`${box} flex items-center gap-3 px-4 py-3`}>
            <span className="size-11 animate-pulse rounded-full bg-white/[0.06]" />
            <div className="space-y-2">
              <div className={`${bar} h-5 w-32`} />
              <div className={`${bar} h-3 w-56`} />
            </div>
            <div className="ml-auto hidden gap-6 md:flex">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="space-y-1.5">
                  <div className={`${bar} h-2.5 w-14`} />
                  <div className={`${bar} h-4 w-16`} />
                </div>
              ))}
            </div>
          </div>
          <div className={`${box} h-[360px] p-4 lg:h-auto lg:flex-[1.15]`}>
            <div className={`${bar} h-full w-full opacity-50`} />
          </div>
          <div className={`${box} hidden space-y-2 p-4 lg:block lg:flex-1`}>
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className={`${bar} h-6`} />
            ))}
          </div>
        </div>
        <div className="hidden flex-col gap-2 lg:flex">
          <div className={`${box} h-36`} />
          <div className={`${box} h-56`} />
          <div className={`${box} flex-1`} />
        </div>
      </div>
    </div>
  );
}

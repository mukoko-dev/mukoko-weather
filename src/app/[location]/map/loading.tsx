import { HeaderSkeleton } from "@/components/layout/HeaderSkeleton";

export default function MapLoading() {
  return (
    <div className="flex h-[100dvh] flex-col">
      <HeaderSkeleton />

      {/* Breadcrumb skeleton */}
      <div className="shrink-0 px-4 pt-2 pb-1 sm:px-6">
        <div className="flex items-center gap-1">
          <div className="h-3 w-10 animate-pulse rounded bg-text-tertiary/15" />
          <span className="text-text-tertiary/30">/</span>
          <div className="h-3 w-14 animate-pulse rounded bg-text-tertiary/15" />
          <span className="text-text-tertiary/30">/</span>
          <div className="h-3 w-8 animate-pulse rounded bg-text-tertiary/15" />
        </div>
      </div>

      {/* Layer switcher skeleton */}
      <div className="flex shrink-0 gap-2 px-4 py-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-[44px] w-20 animate-pulse rounded-[var(--radius-badge)] bg-text-tertiary/10" />
        ))}
      </div>

      {/* Map skeleton fills remaining space */}
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 animate-pulse bg-surface-card" role="status" aria-label="Loading map">
          <div className="absolute inset-0 grid grid-cols-4 grid-rows-3 gap-px opacity-[0.04]">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="bg-text-primary" />
            ))}
          </div>
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <div className="h-8 w-8 rounded-full bg-primary/20" />
          </div>
          <span className="sr-only">Loading map</span>
        </div>
      </div>
    </div>
  );
}

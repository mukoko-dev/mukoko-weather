import { HeaderSkeleton } from "@/components/layout/HeaderSkeleton";

export default function AtmosphereLoading() {
  return (
    <>
      <HeaderSkeleton />

      {/* Breadcrumb skeleton */}
      <div className="mx-auto max-w-5xl px-4 pt-4 sm:px-6 md:px-8">
        <div className="flex items-center gap-1">
          <div className="h-3 w-10 animate-pulse rounded bg-text-tertiary/15" />
          <span className="text-text-tertiary/30">/</span>
          <div className="h-3 w-14 animate-pulse rounded bg-text-tertiary/15" />
          <span className="text-text-tertiary/30">/</span>
          <div className="h-3 w-20 animate-pulse rounded bg-text-tertiary/15" />
        </div>
      </div>

      <main className="mx-auto max-w-5xl px-4 py-6 pb-24 sm:pb-6 sm:px-6 md:px-8">
        {/* Title skeleton */}
        <div className="h-8 w-64 animate-pulse rounded bg-text-tertiary/15" />
        <div className="mt-2 h-4 w-48 animate-pulse rounded bg-text-tertiary/10" />

        {/* Season badge skeleton */}
        <div className="mt-4 mb-4">
          <div className="h-7 w-56 animate-pulse rounded-[var(--radius-badge)] bg-text-tertiary/10" />
        </div>

        {/* Metric cards skeleton */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm">
              <div className="h-4 w-16 animate-pulse rounded bg-text-tertiary/15" />
              <div className="mt-2 h-6 w-20 animate-pulse rounded bg-text-tertiary/15" />
              <div className="mt-1 h-3 w-24 animate-pulse rounded bg-text-tertiary/10" />
            </div>
          ))}
        </div>

        {/* Chart skeleton */}
        <div className="mt-8 rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
          <div className="h-6 w-40 animate-pulse rounded bg-text-tertiary/15" />
          <div className="mt-1 h-4 w-32 animate-pulse rounded bg-text-tertiary/10" />
          <div className="mt-4 space-y-6">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i}>
                <div className="mb-2 h-4 w-36 animate-pulse rounded bg-text-tertiary/10" />
                <div className="aspect-[16/5] w-full animate-pulse rounded bg-text-tertiary/10" />
              </div>
            ))}
          </div>
        </div>
      </main>
    </>
  );
}

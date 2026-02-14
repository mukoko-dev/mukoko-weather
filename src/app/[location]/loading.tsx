import { MukokoLogo } from "@/components/brand/MukokoLogo";

export default function LocationLoading() {
  return (
    <div className="min-h-screen bg-background">
      {/* Header skeleton */}
      <header className="sticky top-0 z-30 border-b border-text-tertiary/10 bg-surface-base/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-4 py-3 sm:pl-6 md:pl-8">
          <MukokoLogo className="text-lg sm:text-xl" />
          <div className="flex shrink-0 items-center gap-0.5 rounded-[var(--radius-badge)] bg-primary/10 p-1">
            <div className="h-10 w-10 rounded-full" />
            <div className="h-10 w-10 rounded-full" />
            <div className="h-10 w-10 rounded-full" />
          </div>
        </div>
      </header>

      {/* Breadcrumb skeleton */}
      <nav className="mx-auto max-w-5xl px-4 pt-4 sm:pl-6 md:pl-8">
        <div className="flex items-center gap-2">
          <div className="h-3 w-10 animate-pulse rounded bg-text-tertiary/15" />
          <span className="text-xs text-text-tertiary">/</span>
          <div className="h-3 w-20 animate-pulse rounded bg-text-tertiary/15" />
          <span className="text-xs text-text-tertiary">/</span>
          <div className="h-3 w-16 animate-pulse rounded bg-text-tertiary/20" />
        </div>
      </nav>

      <main className="mx-auto max-w-5xl px-4 py-6 sm:pl-6 md:pl-8">
        {/* Season badge skeleton */}
        <div className="mb-4">
          <div className="h-6 w-32 animate-pulse rounded-[var(--radius-badge)] bg-primary/10" />
        </div>

        {/* Main grid */}
        <div className="grid gap-6 lg:grid-cols-3">
          {/* Left column */}
          <div className="min-w-0 space-y-6 lg:col-span-2">
            {/* CurrentConditions skeleton */}
            <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
              {/* Location name + condition */}
              <div className="flex items-center justify-between">
                <div className="space-y-2">
                  <div className="h-5 w-32 animate-pulse rounded bg-text-tertiary/15" />
                  <div className="h-4 w-24 animate-pulse rounded bg-text-tertiary/10" />
                </div>
                <div className="h-12 w-12 animate-pulse rounded-full bg-primary/10" />
              </div>
              {/* Temperature */}
              <div className="mt-4 flex items-baseline gap-3">
                <div className="h-16 w-28 animate-pulse rounded bg-text-tertiary/15" />
                <div className="h-4 w-20 animate-pulse rounded bg-text-tertiary/10" />
              </div>
              {/* Stats grid */}
              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="space-y-2 rounded-[var(--radius-card)] bg-surface-dim/50 p-3">
                    <div className="h-3 w-14 animate-pulse rounded bg-text-tertiary/10" />
                    <div className="h-5 w-12 animate-pulse rounded bg-text-tertiary/15" />
                  </div>
                ))}
              </div>
            </div>

            {/* AI Summary skeleton */}
            <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
              <div className="h-5 w-40 animate-pulse rounded bg-text-tertiary/15" />
              <div className="mt-4 space-y-2">
                <div className="h-3 w-full animate-pulse rounded bg-text-tertiary/10" />
                <div className="h-3 w-5/6 animate-pulse rounded bg-text-tertiary/10" />
                <div className="h-3 w-4/6 animate-pulse rounded bg-text-tertiary/10" />
              </div>
            </div>
          </div>

          {/* Right column */}
          <div className="min-w-0 space-y-6">
            {/* Daily forecast skeleton */}
            <div className="rounded-[var(--radius-card)] bg-surface-card p-4 shadow-sm sm:p-6">
              <div className="h-5 w-28 animate-pulse rounded bg-text-tertiary/15" />
              <div className="mt-4 space-y-3">
                {Array.from({ length: 7 }).map((_, i) => (
                  <div key={i} className="flex items-center justify-between">
                    <div className="h-3 w-12 animate-pulse rounded bg-text-tertiary/10" />
                    <div className="h-6 w-6 animate-pulse rounded-full bg-primary/10" />
                    <div className="h-3 w-16 animate-pulse rounded bg-text-tertiary/15" />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

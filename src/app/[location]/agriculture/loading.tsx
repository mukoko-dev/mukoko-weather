import { HeaderSkeleton } from "@/components/layout/HeaderSkeleton";
import { BreadcrumbSkeleton } from "@/components/layout/Breadcrumb";
import { ChartSkeleton, Skeleton } from "@/components/ui/skeleton";
import { AgricultureSnapshotSkeleton } from "@/components/weather/SectionSkeleton";

export default function AgricultureLoading() {
  return (
    <>
      <HeaderSkeleton />

      <BreadcrumbSkeleton />

      <main className="mx-auto max-w-5xl px-4 py-8 pb-[var(--mobile-nav-clearance)] sm:pb-8 sm:px-6 md:px-8">
        <div role="status" aria-label="Loading">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="mt-2 h-4 w-48" />
          <div className="mt-4 mb-6">
            <Skeleton className="h-7 w-56 rounded-[var(--radius-badge)]" />
          </div>
          <AgricultureSnapshotSkeleton />
          <div className="mt-6 space-y-6">
            {Array.from({ length: 3 }).map((_, i) => (
              <ChartSkeleton key={i} />
            ))}
          </div>
        </div>
      </main>
    </>
  );
}

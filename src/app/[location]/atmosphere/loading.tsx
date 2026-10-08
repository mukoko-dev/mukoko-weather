import { HeaderSkeleton } from "@/components/layout/HeaderSkeleton";
import { BreadcrumbSkeleton } from "@/components/layout/Breadcrumb";
import {
  ChartSkeleton,
  MetricCardSkeleton,
  Skeleton,
} from "@/components/ui/skeleton";

export default function AtmosphereLoading() {
  return (
    <>
      <HeaderSkeleton />

      <BreadcrumbSkeleton />

      <main className="mx-auto max-w-5xl px-4 py-8 pb-24 sm:pb-8 sm:px-6 md:px-8">
        {/* Title skeleton */}
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-2 h-4 w-48" />

        {/* Season badge skeleton */}
        <div className="mt-4 mb-4">
          <Skeleton className="h-7 w-56 rounded-[var(--radius-badge)]" />
        </div>

        {/* Metric cards skeleton */}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <MetricCardSkeleton key={i} />
          ))}
        </div>

        {/* Chart skeletons */}
        <div className="mt-8 space-y-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <ChartSkeleton key={i} />
          ))}
        </div>
      </main>
    </>
  );
}

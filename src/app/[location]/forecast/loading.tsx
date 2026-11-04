import { PageShellSkeleton } from "@/components/layout/PageShell";
import { ForecastBodySkeleton } from "@/components/weather/SubRouteSkeletons";
import { Skeleton } from "@/components/ui/skeleton";

export default function ForecastLoading() {
  return (
    <PageShellSkeleton width="wide" breadcrumb>
      {/* Title skeleton */}
      <Skeleton className="h-8 w-56" />
      <Skeleton className="mt-2 h-4 w-48" />

      {/* Season badge skeleton */}
      <div className="mt-4 mb-4">
        <Skeleton className="h-7 w-56 rounded-[var(--radius-badge)]" />
      </div>

      {/* The page's own body skeleton: the same grid as the loaded page. */}
      <ForecastBodySkeleton />
    </PageShellSkeleton>
  );
}

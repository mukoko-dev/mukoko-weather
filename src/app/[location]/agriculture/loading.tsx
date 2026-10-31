import { PageShellSkeleton } from "@/components/layout/PageShell";
import { ChartSkeleton, Skeleton } from "@/components/ui/skeleton";
import { AgricultureSnapshotSkeleton } from "@/components/weather/SectionSkeleton";

export default function AgricultureLoading() {
  return (
    <PageShellSkeleton width="wide" breadcrumb>
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
    </PageShellSkeleton>
  );
}

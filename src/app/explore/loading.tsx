import { Skeleton } from "@/components/ui/skeleton";
import { ExploreLoadingShell } from "./ExploreLoadingShell";

export default function ExploreLoading() {
  return (
    <ExploreLoadingShell
      mainLabel="Loading explore page"
      srText="Loading explore page…"
    >
      <Skeleton className="h-8 w-56 mb-2" />
      <Skeleton className="h-4 w-80 mb-8" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="rounded-[var(--radius-card)] bg-surface-card p-5 shadow-sm"
          >
            <div className="flex items-start justify-between mb-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-8 rounded-full" />
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4 mt-1" />
          </div>
        ))}
      </div>
    </ExploreLoadingShell>
  );
}

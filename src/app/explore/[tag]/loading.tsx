import { Skeleton } from "@/components/ui/skeleton";
import { ExploreLoadingShell } from "../ExploreLoadingShell";

export default function ExploreTagLoading() {
  return (
    <ExploreLoadingShell
      mainLabel="Loading locations"
      srText="Loading locations…"
    >
      <Skeleton className="h-8 w-48 mb-2" />
      <Skeleton className="h-4 w-96 mb-8" />
      {/* Two province groups */}
      {Array.from({ length: 2 }).map((_, g) => (
        <div key={g} className="mb-8">
          <Skeleton className="h-5 w-36 mb-3" />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-[var(--radius-card)] bg-surface-card px-4 py-3 shadow-sm"
              >
                <div className="flex-1 min-w-0">
                  <Skeleton className="h-4 w-28 mb-1" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-5 w-14 rounded-full ml-2 shrink-0" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </ExploreLoadingShell>
  );
}

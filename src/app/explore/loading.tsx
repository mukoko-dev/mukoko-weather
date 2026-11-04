import {
  PageHeaderSkeleton,
  SkeletonStack,
} from "@/components/layout/PageShell";
import { Skeleton } from "@/components/ui/skeleton";
import { ExploreLoadingShell } from "./ExploreLoadingShell";

export default function ExploreLoading() {
  return (
    <ExploreLoadingShell
      mainLabel="Loading explore page"
      srText="Loading explore page…"
    >
      <PageHeaderSkeleton />
      <SkeletonStack count={8} className="herd-grid">
        {() => (
          <div className="chameleon p-[var(--space-card)]">
            <div className="flex items-start justify-between mb-2">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-5 w-8 rounded-full" />
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4 mt-1" />
          </div>
        )}
      </SkeletonStack>
    </ExploreLoadingShell>
  );
}

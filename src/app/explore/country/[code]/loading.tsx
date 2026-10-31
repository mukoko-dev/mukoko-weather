import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { SkeletonStack } from "@/components/layout/PageShell";
import { ExploreLoadingShell } from "../../ExploreLoadingShell";

export default function CountryDetailLoading() {
  return (
    <ExploreLoadingShell
      mainLabel="Loading country"
      srText="Loading country details…"
    >
      <div className="flex items-center gap-3 mb-8">
        <Skeleton className="h-12 w-12 rounded-full" />
        <div>
          <Skeleton className="h-8 w-48 mb-2" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <SkeletonStack count={6} className="herd-grid">
        {() => <CardSkeleton />}
      </SkeletonStack>
    </ExploreLoadingShell>
  );
}

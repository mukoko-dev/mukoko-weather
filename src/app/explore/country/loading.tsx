import { Skeleton, CardSkeleton } from "@/components/ui/skeleton";
import { ExploreLoadingShell } from "../ExploreLoadingShell";

export default function ExploreCountryLoading() {
  return (
    <ExploreLoadingShell
      mainLabel="Loading countries"
      srText="Loading countries…"
    >
      <Skeleton className="h-8 w-48 mb-2" />
      <Skeleton className="h-4 w-64 mb-8" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 9 }).map((_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    </ExploreLoadingShell>
  );
}

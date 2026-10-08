import { Skeleton, CardSkeleton } from "@/components/ui/skeleton";
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
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    </ExploreLoadingShell>
  );
}

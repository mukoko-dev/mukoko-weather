import { Skeleton, CardSkeleton } from "@/components/ui/skeleton";
import { ExploreLoadingShell } from "../../../ExploreLoadingShell";

export default function ProvinceDetailLoading() {
  return (
    <ExploreLoadingShell
      mainLabel="Loading province"
      srText="Loading province details…"
    >
      <div className="flex items-center gap-3 mb-8">
        <Skeleton className="h-10 w-10 rounded-full" />
        <div>
          <Skeleton className="h-8 w-48 mb-2" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    </ExploreLoadingShell>
  );
}

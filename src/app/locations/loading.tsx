import { PageShellSkeleton } from "@/components/layout/PageShell";
import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton for /locations, in the same frame as the page. */
export default function LocationsLoading() {
  return (
    <PageShellSkeleton label="Loading your locations">
      <Skeleton className="mb-6 h-9 w-40" />
      <ul className="flex flex-col gap-4">
        {Array.from({ length: 2 }).map((_, i) => (
          <li key={i} className="chameleon min-h-40 p-5">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="mt-2 h-4 w-24" />
            <Skeleton className="mt-10 h-4 w-48" />
          </li>
        ))}
      </ul>
    </PageShellSkeleton>
  );
}

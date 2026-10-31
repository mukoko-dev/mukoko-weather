import { PageShellSkeleton } from "@/components/layout/PageShell";
import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton for status, in the same frame as the page. */
export default function StatusLoading() {
  return (
    <PageShellSkeleton width="prose" label="Loading status">
      <>
        <Skeleton className="mb-8 h-9 w-40" />
        <div className="herd">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </>
    </PageShellSkeleton>
  );
}

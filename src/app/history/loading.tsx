import { PageShellSkeleton } from "@/components/layout/PageShell";
import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton for history, in the same frame as the page. */
export default function HistoryLoading() {
  return (
    <PageShellSkeleton width="wide" label="Loading history">
      <>
        <Skeleton className="mb-3 h-9 w-56" />
        <Skeleton className="mb-8 h-4 w-80 max-w-full" />
        <div className="herd">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </>
    </PageShellSkeleton>
  );
}

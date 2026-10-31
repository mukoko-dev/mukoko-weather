import { PageShellSkeleton } from "@/components/layout/PageShell";
import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton for developers/keys, in the same frame as the page. */
export default function ApiKeysLoading() {
  return (
    <PageShellSkeleton width="prose" label="Loading API keys" breadcrumb>
      <>
        <Skeleton className="mb-3 h-9 w-48" />
        <Skeleton className="mb-8 h-4 w-72 max-w-full" />
        <div className="herd">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      </>
    </PageShellSkeleton>
  );
}

import {
  PageHeaderSkeleton,
  PageShellSkeleton,
} from "@/components/layout/PageShell";
import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton for /releases: title, intro, then two release cards. */
export default function ReleasesLoading() {
  return (
    <PageShellSkeleton breadcrumb label="Loading release notes">
      <PageHeaderSkeleton />
      <div className="herd">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="chameleon p-[var(--space-card)]">
            <Skeleton className="mb-3 h-4 w-40" />
            <Skeleton className="mb-4 h-7 w-3/4" />
            <Skeleton className="mb-2 h-4 w-full" />
            <Skeleton className="mb-2 h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ))}
      </div>
    </PageShellSkeleton>
  );
}

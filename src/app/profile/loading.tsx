import { PageShellSkeleton } from "@/components/layout/PageShell";
import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton for profile, in the same frame as the page. */
export default function ProfileLoading() {
  return (
    <PageShellSkeleton width="settings" label="Loading profile">
      <div className="herd">
        <div className="flex flex-col items-center gap-3">
          <Skeleton className="h-20 w-20 rounded-full" />
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-56" />
        </div>
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    </PageShellSkeleton>
  );
}

import { HeaderSkeleton } from "@/components/layout/HeaderSkeleton";
import { BreadcrumbSkeleton } from "@/components/layout/Breadcrumb";
import { Footer } from "@/components/layout/Footer";
import { Skeleton } from "@/components/ui/skeleton";

/** Skeleton for /releases: title, intro, then two release cards. */
export default function ReleasesLoading() {
  return (
    <>
      <HeaderSkeleton />
      <BreadcrumbSkeleton className="max-w-3xl" />
      <main
        aria-label="Loading release notes"
        className="mx-auto max-w-3xl px-4 py-8 pb-[var(--mobile-nav-clearance)] sm:px-6 sm:pb-10 md:px-8"
      >
        <div role="status" aria-label="Loading" aria-busy="true">
          <span className="sr-only">Loading release notes…</span>
          <Skeleton className="mb-3 h-9 w-56" />
          <Skeleton className="mb-8 h-4 w-80 max-w-full" />
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
        </div>
      </main>
      <Footer />
    </>
  );
}

import { Skeleton } from "@/components/ui/skeleton";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";

export default function ExploreLoading() {
  return (
    <>
      <Header />
      <div className="mx-auto max-w-5xl px-4 pt-4 sm:px-6 md:px-8">
        <Skeleton className="h-4 w-40" />
      </div>
      <main
        aria-label="Loading explore page"
        className="mx-auto max-w-5xl overflow-x-hidden px-4 py-6 pb-24 sm:px-6 sm:pb-6 md:px-8"
      >
        <div role="status" aria-label="Loading" aria-busy="true">
          <span className="sr-only">Loading explore page…</span>
          <Skeleton className="h-8 w-56 mb-2" />
          <Skeleton className="h-4 w-80 mb-8" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="rounded-[var(--radius-card)] bg-surface-card p-5 shadow-sm">
                <div className="flex items-start justify-between mb-2">
                  <Skeleton className="h-5 w-32" />
                  <Skeleton className="h-5 w-8 rounded-full" />
                </div>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4 mt-1" />
              </div>
            ))}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}

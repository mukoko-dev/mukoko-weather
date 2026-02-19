import { Skeleton, CardSkeleton } from "@/components/ui/skeleton";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";

export default function ExploreCountryLoading() {
  return (
    <>
      <Header />
      <div className="mx-auto max-w-5xl px-4 pt-4 sm:px-6 md:px-8">
        <Skeleton className="h-4 w-48" />
      </div>
      <main
        aria-label="Loading countries"
        className="mx-auto max-w-5xl overflow-x-hidden px-4 py-6 pb-24 sm:px-6 sm:pb-6 md:px-8"
      >
        <div role="status" aria-label="Loading" aria-busy="true">
          <span className="sr-only">Loading countries&hellip;</span>
          <Skeleton className="h-8 w-48 mb-2" />
          <Skeleton className="h-4 w-64 mb-8" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}

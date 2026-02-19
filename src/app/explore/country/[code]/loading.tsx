import { Skeleton, CardSkeleton } from "@/components/ui/skeleton";
import { Header } from "@/components/layout/Header";
import { Footer } from "@/components/layout/Footer";

export default function CountryDetailLoading() {
  return (
    <>
      <Header />
      <div className="mx-auto max-w-5xl px-4 pt-4 sm:px-6 md:px-8">
        <Skeleton className="h-4 w-56" />
      </div>
      <main
        aria-label="Loading country"
        className="mx-auto max-w-5xl overflow-x-hidden px-4 py-6 pb-24 sm:px-6 sm:pb-6 md:px-8"
      >
        <div role="status" aria-label="Loading" aria-busy="true">
          <span className="sr-only">Loading country details&hellip;</span>
          <div className="flex items-center gap-3 mb-8">
            <Skeleton className="h-12 w-12 rounded-full" />
            <div>
              <Skeleton className="h-8 w-48 mb-2" />
              <Skeleton className="h-4 w-32" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <CardSkeleton key={i} />
            ))}
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}

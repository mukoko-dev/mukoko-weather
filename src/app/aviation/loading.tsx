import { Skeleton, CardSkeleton } from "@/components/ui/skeleton";
import { Header } from "@/components/layout/Header";

export default function AviationLoading() {
  return (
    <>
      <Header />
      <main
        id="main-content"
        aria-label="Loading aviation briefing"
        className="mx-auto max-w-3xl px-4 py-6 pb-24 sm:px-6 sm:pb-8 md:px-8"
      >
        <div role="status" aria-label="Loading" aria-busy="true" className="space-y-6">
          <span className="sr-only">Loading aviation weather briefing...</span>
          <div className="space-y-2">
            <Skeleton className="h-7 w-72 max-w-full" />
            <Skeleton className="h-4 w-full max-w-xl" />
          </div>
          {/* Route selection card */}
          <div className="baobab p-5 space-y-4">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-9 w-48" />
          </div>
          {/* Briefing result placeholders */}
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </main>
    </>
  );
}

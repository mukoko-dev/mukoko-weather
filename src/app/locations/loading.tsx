import { Skeleton } from "@/components/ui/skeleton";
import { Header } from "@/components/layout/Header";

export default function LocationsLoading() {
  return (
    <>
      <Header />
      <main
        id="main-content"
        className="mx-auto max-w-3xl px-4 py-10 pb-28 sm:px-6 md:px-8"
      >
        <div role="status" aria-label="Loading" aria-busy="true">
          <span className="sr-only">Loading your locations…</span>
          <Skeleton className="mb-6 h-9 w-40" />
          <ul className="flex flex-col gap-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <li key={i} className="chameleon min-h-40 p-5">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="mt-2 h-4 w-24" />
                <Skeleton className="mt-10 h-4 w-48" />
              </li>
            ))}
          </ul>
        </div>
      </main>
    </>
  );
}

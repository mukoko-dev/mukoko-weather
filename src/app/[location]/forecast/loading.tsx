import { HeaderSkeleton } from "@/components/layout/HeaderSkeleton";
import { BreadcrumbSkeleton } from "@/components/layout/Breadcrumb";
import {
  DailyForecastSkeleton,
  HourlyForecastSkeleton,
} from "@/components/weather/SectionSkeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function ForecastLoading() {
  return (
    <>
      <HeaderSkeleton />

      <BreadcrumbSkeleton />

      <main className="mx-auto max-w-5xl px-4 py-8 pb-24 sm:pb-8 sm:px-6 md:px-8">
        {/* Title skeleton */}
        <Skeleton className="h-8 w-56" />
        <Skeleton className="mt-2 h-4 w-48" />

        {/* Season badge skeleton */}
        <div className="mt-4 mb-4">
          <Skeleton className="h-7 w-56 rounded-[var(--radius-badge)]" />
        </div>

        <div className="mt-6">
          <HourlyForecastSkeleton />
        </div>

        <div className="mt-8">
          <DailyForecastSkeleton />
        </div>
      </main>
    </>
  );
}

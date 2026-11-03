import { ChartSkeleton, MetricCardSkeleton } from "@/components/ui/skeleton";
import {
  DailyForecastSkeleton,
  HourlyForecastSkeleton,
  SectionSkeleton,
} from "@/components/weather/SectionSkeleton";

/**
 * The weather-dependent body of `/[location]/forecast` while its forecast is
 * on the way, in the same grid as the real page (2 columns from `lg`, the sun
 * times spanning both), so nothing moves when the data arrives. Shared by the
 * route's `loading.tsx` and the dashboard's own first render.
 */
export function ForecastBodySkeleton() {
  return (
    <div className="mt-6 grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <HourlyForecastSkeleton />
      <DailyForecastSkeleton />
      <SectionSkeleton className="h-32 lg:col-span-2" />
    </div>
  );
}

/**
 * The weather-dependent body of `/[location]/atmosphere` while its forecast is
 * on the way: the metric cards, then the 24-hour charts. (Air quality has its
 * own read and does not wait for the forecast.) Shared by `loading.tsx` and
 * the dashboard's own first render.
 */
export function AtmosphereBodySkeleton() {
  return (
    <>
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <MetricCardSkeleton key={i} />
        ))}
      </div>
      <div className="mt-8 space-y-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <ChartSkeleton key={i} />
        ))}
      </div>
    </>
  );
}

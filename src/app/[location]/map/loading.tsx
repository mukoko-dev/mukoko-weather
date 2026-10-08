import { HeaderSkeleton } from "@/components/layout/HeaderSkeleton";
import { BreadcrumbSkeleton } from "@/components/layout/Breadcrumb";
import { MapSkeleton } from "@/components/weather/map/MapSkeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function MapLoading() {
  return (
    <div className="flex h-[100dvh] flex-col">
      <HeaderSkeleton />

      <BreadcrumbSkeleton className="w-full shrink-0 pb-3" />

      {/* Layer switcher skeleton */}
      <div className="flex shrink-0 gap-2 px-4 py-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton
            key={i}
            className="h-[44px] w-20 rounded-[var(--radius-badge)]"
          />
        ))}
      </div>

      {/* Map skeleton fills remaining space */}
      <div className="relative min-h-0 flex-1">
        <MapSkeleton fill className="rounded-none" />
      </div>
    </div>
  );
}

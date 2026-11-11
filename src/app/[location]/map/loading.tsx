import { QuickActions } from "@/components/layout/QuickActions";
import { MapSkeleton } from "@/components/weather/map/MapSkeleton";

export default function MapLoading() {
  return (
    <div className="relative h-[100dvh] w-full overflow-hidden">
      {/* The same solid group the map draws, so it is already there (and live)
          while the map loads and does not appear when the map arrives. The
          loader is replaced by the page, never shown beside it. */}
      <QuickActions tone="solid" placement="float" />
      <MapSkeleton fill className="rounded-none" />
    </div>
  );
}

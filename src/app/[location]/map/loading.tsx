import { MapSkeleton } from "@/components/weather/map/MapSkeleton";

export default function MapLoading() {
  return (
    <div className="relative h-[100dvh] w-full overflow-hidden">
      <MapSkeleton fill className="rounded-none" />
    </div>
  );
}

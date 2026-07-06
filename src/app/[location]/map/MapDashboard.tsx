"use client";

import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import { Header } from "@/components/layout/Header";
import { Breadcrumb } from "@/components/layout/Breadcrumb";
import { MapSkeleton } from "@/components/weather/map/MapSkeleton";
import { WeatherLayerPanel } from "@/components/weather/map/WeatherLayerPanel";
import { DEFAULT_LAYER } from "@/lib/map-layers";
import type { WeatherLocation } from "@/lib/locations";

const MapLibreMap = dynamic(
  () =>
    import("@/components/weather/map/MapLibreMap").then((m) => ({
      default: m.MapLibreMap,
    })),
  { ssr: false, loading: () => <MapSkeleton fill className="rounded-none" /> },
);

interface MapDashboardProps {
  location: WeatherLocation;
}

export function MapDashboard({ location }: MapDashboardProps) {
  const [activeLayer, setActiveLayer] = useState<string | null>(DEFAULT_LAYER);

  const handleLayerChange = useCallback((layerId: string | null) => {
    setActiveLayer(layerId);
  }, []);

  return (
    <div className="flex h-[100dvh] flex-col">
      <Header />

      <Breadcrumb
        items={[
          { label: "Home", href: "/" },
          { label: location.name, href: `/${location.slug}` },
          { label: "Map" },
        ]}
        className="pb-3"
      />

      {/* Full-viewport map with overlaid controls */}
      <main
        id="main-content"
        className="relative min-h-0 flex-1 overflow-hidden"
        aria-label={`Weather map for ${location.name}`}
      >
        <h1 className="sr-only">{location.name} Weather Map</h1>

        {/* Map fills entire area */}
        <MapLibreMap
          lat={location.lat}
          lon={location.lon}
          zoom={8}
          interactive
          weatherLayer={activeLayer}
          className="h-full w-full"
        />

        {/* Bottom-right overlay: weather layer panel. The map's attribution
            control is pinned bottom-left (see MapLibreMap) so the two never
            collide; the zoom control stays top-right. */}
        <div className="pointer-events-none absolute bottom-6 right-3 z-10 sm:bottom-4">
          <WeatherLayerPanel
            activeLayer={activeLayer}
            onLayerChange={handleLayerChange}
            locationSlug={location.slug}
          />
        </div>

        {/* Mobile nav bottom padding — transparent spacer */}
        <div
          className="absolute inset-x-0 bottom-0 h-16 sm:hidden"
          aria-hidden="true"
        />
      </main>
    </div>
  );
}

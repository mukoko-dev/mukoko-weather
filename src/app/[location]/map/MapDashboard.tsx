"use client";

import { useCallback, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { MapSkeleton } from "@/components/weather/map/MapSkeleton";
import { WeatherLayerPanel } from "@/components/weather/map/WeatherLayerPanel";
import type { WeatherLocation } from "@/lib/locations";

const MapLibreMap = dynamic(
  () => import("@/components/weather/map/MapLibreMap").then((m) => ({ default: m.MapLibreMap })),
  { ssr: false, loading: () => <MapSkeleton className="h-full rounded-none" /> },
);

interface MapDashboardProps {
  location: WeatherLocation;
}

export function MapDashboard({ location }: MapDashboardProps) {
  const [activeLayer, setActiveLayer] = useState<string | null>("precipitationIntensity");

  const handleLayerChange = useCallback((layerId: string | null) => {
    setActiveLayer(layerId);
  }, []);

  return (
    <div className="flex h-[100dvh] flex-col">
      <Header />

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

        {/* Top-left overlay: location name + back link */}
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex flex-col gap-1.5">
          <div className="pointer-events-auto">
            <Link
              href={`/${location.slug}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-primary/10 bg-surface-card/90 px-3 py-1.5 text-sm font-medium text-text-secondary shadow backdrop-blur-sm transition-colors hover:bg-surface-card hover:text-text-primary"
            >
              ← {location.name}
            </Link>
          </div>
        </div>

        {/* Bottom-left overlay: weather layer panel */}
        <div className="pointer-events-none absolute bottom-6 left-3 z-10 sm:bottom-4">
          <WeatherLayerPanel
            activeLayer={activeLayer}
            onLayerChange={handleLayerChange}
            locationSlug={location.slug}
          />
        </div>

        {/* Mobile nav bottom padding — transparent spacer */}
        <div className="absolute inset-x-0 bottom-0 h-16 sm:hidden" aria-hidden="true" />
      </main>
    </div>
  );
}

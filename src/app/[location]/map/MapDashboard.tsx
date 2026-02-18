"use client";

import { useCallback } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Header } from "@/components/layout/Header";
import { MapLayerSwitcher } from "@/components/weather/map/MapLayerSwitcher";
import { MapSkeleton } from "@/components/weather/map/MapSkeleton";
import { DEFAULT_LAYER } from "@/lib/map-layers";
import type { ZimbabweLocation } from "@/lib/locations";

const LeafletMapFull = dynamic(
  () => import("@/components/weather/map/LeafletMapFull"),
  { ssr: false, loading: () => <MapSkeleton className="h-full rounded-none" /> },
);

const BASE_URL = "https://weather.mukoko.com";

interface MapDashboardProps {
  location: ZimbabweLocation;
}

export function MapDashboard({ location }: MapDashboardProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const activeLayer = searchParams.get("layer") ?? DEFAULT_LAYER;

  const handleLayerChange = useCallback(
    (layerId: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("layer", layerId);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  return (
    <div className="flex h-[100dvh] flex-col">
      <Header />

      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="shrink-0 px-4 pt-2 pb-1 sm:px-6">
        <ol className="flex items-center gap-1 text-xs text-text-tertiary">
          <li>
            <a href={BASE_URL} className="hover:text-text-secondary transition-colors focus-visible:outline-2 focus-visible:outline-primary focus-visible:rounded">
              Home
            </a>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link href={`/${location.slug}`} className="hover:text-text-secondary transition-colors focus-visible:outline-2 focus-visible:outline-primary focus-visible:rounded">
              {location.name}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li aria-current="page">
            <span className="font-medium text-text-primary">Map</span>
          </li>
        </ol>
      </nav>

      {/* Layer switcher */}
      <div className="shrink-0">
        <MapLayerSwitcher
          activeLayer={activeLayer}
          onLayerChange={handleLayerChange}
        />
      </div>

      {/* Map fills remaining viewport */}
      <main
        id="main-content"
        className="relative z-0 min-h-0 flex-1"
        aria-label={`Weather map for ${location.name}`}
      >
        <h1 className="sr-only">{location.name} Weather Map</h1>
        <LeafletMapFull
          key={activeLayer}
          lat={location.lat}
          lon={location.lon}
          layer={activeLayer}
        />
      </main>
    </div>
  );
}

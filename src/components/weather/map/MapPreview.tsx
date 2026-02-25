"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { MapSkeleton } from "./MapSkeleton";
import type { ZimbabweLocation } from "@/lib/locations";

// Leaflet requires the DOM — dynamic import with ssr: false
const LeafletMap = dynamic(() => import("./LeafletMapPreview"), {
  ssr: false,
  loading: () => <MapSkeleton />,
});

interface MapPreviewProps {
  location: ZimbabweLocation;
}

export function MapPreview({ location }: MapPreviewProps) {
  return (
    <section aria-labelledby="map-preview-heading">
      <div className="rounded-[var(--radius-card)] border border-primary/25 bg-surface-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between p-5 pb-2 sm:px-6">
          <h2
            id="map-preview-heading"
            className="text-lg font-semibold text-text-primary font-heading"
          >
            Weather Map
          </h2>
          <Link
            href={`/${location.slug}/map`}
            className="text-base font-medium text-primary transition-colors hover:text-primary/80 min-h-[44px] px-2 flex items-center"
          >
            Explore map &rarr;
          </Link>
        </div>

        {/* Map preview — non-interactive teaser, z-0 prevents Leaflet z-index from bleeding over modals */}
        <Link
          href={`/${location.slug}/map`}
          className="relative z-0 block w-full aspect-[16/9] focus-visible:outline-2 focus-visible:outline-primary"
          aria-label={`Open weather map for ${location.name}`}
        >
          <LeafletMap lat={location.lat} lon={location.lon} />
          {/* Gradient overlay — "tap to expand" affordance */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface-card/80 to-transparent"
            aria-hidden="true"
          />
        </Link>
      </div>
    </section>
  );
}

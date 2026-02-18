"use client";

import dynamic from "next/dynamic";
import { useState, useCallback } from "react";
import { MapSkeleton } from "./MapSkeleton";
import { DEFAULT_LAYER } from "@/lib/map-layers";
import type { ZimbabweLocation } from "@/lib/locations";

// Leaflet requires the DOM — dynamic import with ssr: false
const LeafletMap = dynamic(() => import("./LeafletMapPreview"), {
  ssr: false,
  loading: () => <MapSkeleton />,
});

// MapModal is only loaded when the user taps "Full map"
const MapModal = dynamic(
  () => import("./MapModal").then((m) => ({ default: m.MapModal })),
  { ssr: false },
);

interface MapPreviewProps {
  location: ZimbabweLocation;
}

export function MapPreview({ location }: MapPreviewProps) {
  const [modalOpen, setModalOpen] = useState(false);

  const handleOpen = useCallback(() => setModalOpen(true), []);
  const handleClose = useCallback(() => setModalOpen(false), []);

  return (
    <section aria-labelledby="map-preview-heading">
      <div className="rounded-[var(--radius-card)] bg-surface-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between p-4 pb-2 sm:px-6">
          <h2
            id="map-preview-heading"
            className="text-lg font-semibold text-text-primary font-heading"
          >
            Weather Map
          </h2>
          <button
            onClick={handleOpen}
            className="text-sm font-medium text-primary transition-colors hover:text-primary/80 min-h-[44px] px-2"
            type="button"
          >
            Full map &rarr;
          </button>
        </div>

        {/* Map preview — non-interactive teaser */}
        <button
          onClick={handleOpen}
          className="relative block w-full aspect-[16/9] cursor-pointer focus-visible:outline-2 focus-visible:outline-primary"
          aria-label={`Open full weather map for ${location.name}`}
          type="button"
        >
          <LeafletMap lat={location.lat} lon={location.lon} layer={DEFAULT_LAYER} />
          {/* Gradient overlay — "tap to expand" affordance */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-surface-card/80 to-transparent"
            aria-hidden="true"
          />
        </button>
      </div>

      {/* Full map modal — loaded only when opened */}
      {modalOpen && (
        <MapModal
          location={location}
          open={modalOpen}
          onClose={handleClose}
        />
      )}
    </section>
  );
}

"use client";

import { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { MapLayerSwitcher } from "./MapLayerSwitcher";
import { MapSkeleton } from "./MapSkeleton";
import { DEFAULT_LAYER } from "@/lib/map-layers";
import type { ZimbabweLocation } from "@/lib/locations";

const LeafletMapFull = dynamic(() => import("./LeafletMapFull"), {
  ssr: false,
  loading: () => <MapSkeleton className="h-full rounded-none" />,
});

interface MapModalProps {
  location: ZimbabweLocation;
  open: boolean;
  onClose: () => void;
}

export function MapModal({ location, open, onClose }: MapModalProps) {
  const [activeLayer, setActiveLayer] = useState(DEFAULT_LAYER);

  const handleLayerChange = useCallback((layerId: string) => {
    setActiveLayer(layerId);
  }, []);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[100dvh] flex-col p-0 sm:h-[90vh] sm:max-w-4xl">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <DialogTitle>{location.name} Weather Map</DialogTitle>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Done
          </Button>
        </div>

        {/* Layer switcher */}
        <MapLayerSwitcher
          activeLayer={activeLayer}
          onLayerChange={handleLayerChange}
        />

        {/* Map — fills remaining space */}
        <div className="relative min-h-0 flex-1">
          <LeafletMapFull
            key={activeLayer}
            lat={location.lat}
            lon={location.lon}
            layer={activeLayer}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

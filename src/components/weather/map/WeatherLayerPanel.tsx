"use client";

import { useCallback } from "react";
import { MAP_CHIPS } from "@/lib/map-layers";
import { cn } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";

interface WeatherLayerPanelProps {
  /** Selected chip id (always one: the map shows exactly one layer at a time). */
  activeLayer: string;
  onLayerChange: (layerId: string) => void;
  locationSlug: string;
}

/**
 * Bottom-sheet layer chips. Every chip is labelled (no icon-only controls) and
 * single-select, so only one overlay is shown at a time. Each chip is a
 * 48px-minimum touch target.
 */
export function WeatherLayerPanel({
  activeLayer,
  onLayerChange,
  locationSlug,
}: WeatherLayerPanelProps) {
  const handleSelect = useCallback(
    (id: string) => {
      if (id === activeLayer) return;
      onLayerChange(id);
      trackEvent("map_layer_changed", { layer: id, location: locationSlug });
    },
    [activeLayer, onLayerChange, locationSlug],
  );

  return (
    <div
      role="group"
      aria-label="Map layers"
      className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {MAP_CHIPS.map((chip) => {
        const isActive = chip.id === activeLayer;
        return (
          <button
            key={chip.id}
            type="button"
            onClick={() => handleSelect(chip.id)}
            aria-pressed={isActive}
            className={cn(
              "quail shrink-0 px-4 text-sm font-medium",
              isActive && "font-semibold",
            )}
          >
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}

"use client";

import { createElement, useCallback } from "react";
import {
  Cloud,
  CloudRain,
  Droplets,
  Layers,
  Leaf,
  Thermometer,
  Wind,
  type LucideIcon,
} from "lucide-react";
import { AIR_QUALITY_LAYER_ID, MAP_CHIPS } from "@/lib/map-layers";
import { cn } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";

/**
 * One Lucide icon per layer, same size and stroke as the map's top controls.
 * Keyed by layer id so new layers (added to MAP_CHIPS elsewhere) work with no
 * edit here: an unknown id gets the generic Layers icon. Icons are decorative
 * — every chip keeps its text label.
 */
export const CHIP_ICONS: Record<string, LucideIcon> = {
  [AIR_QUALITY_LAYER_ID]: Leaf,
  precipitationIntensity: CloudRain,
  temperature: Thermometer,
  windSpeed: Wind,
  cloudCover: Cloud,
  humidity: Droplets,
};

export function chipIcon(id: string): LucideIcon {
  return CHIP_ICONS[id] ?? Layers;
}

/** The decorative icon for a layer id (see CHIP_ICONS). */
export function LayerIcon({
  id,
  className,
}: {
  id: string;
  className?: string;
}) {
  return createElement(chipIcon(id), { className, "aria-hidden": true });
}

interface WeatherLayerPanelProps {
  /** Selected chip id (always one: the map shows exactly one layer at a time). */
  activeLayer: string;
  onLayerChange: (layerId: string) => void;
  locationSlug: string;
}

/**
 * Bottom-sheet layer chips. Every chip is labelled (the icon is decorative,
 * never icon-only) and single-select, so only one overlay is shown at a time.
 * Each chip is a 48px-minimum touch target. The row scrolls sideways with a
 * soft edge fade, so more layers can be added without wrapping the sheet.
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
      className="scrollbar-hide -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 scroll-fade-x"
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
              "quail inline-flex shrink-0 items-center gap-2 px-4 text-sm font-medium",
              isActive && "font-semibold",
            )}
          >
            <LayerIcon id={chip.id} className="h-4 w-4" />
            {chip.label}
          </button>
        );
      })}
    </div>
  );
}

"use client";

import { createElement, useCallback } from "react";
import {
  Cloud,
  CloudRain,
  Droplets,
  Layers,
  Satellite,
  SatelliteDish,
  Leaf,
  Thermometer,
  Wind,
  type LucideIcon,
} from "lucide-react";
import {
  AIR_QUALITY_LAYER_ID,
  MAP_CHIPS,
  type MapChip,
} from "@/lib/map-layers";
import type { MapModel } from "@/lib/map-sources";
import { cn } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";

/**
 * One Lucide icon per layer, same size and stroke as the map's top controls.
 * Keyed by layer id so layers added to the chip list elsewhere (satellite,
 * model fields) work with no edit here: an unknown id gets the generic
 * Layers icon. Icons are decorative; every chip keeps its text label.
 */
export const CHIP_ICONS: Record<string, LucideIcon> = {
  [AIR_QUALITY_LAYER_ID]: Leaf,
  precipitationIntensity: CloudRain,
  temperature: Thermometer,
  windSpeed: Wind,
  cloudCover: Cloud,
  humidity: Droplets,
  satellite: Satellite,
  satelliteRain: SatelliteDish,
  modelTemperature: Thermometer,
  modelPrecipitation: CloudRain,
  modelWind: Wind,
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
  /** Chips to offer (defaults to MAP_CHIPS; the dashboard adds flagged ones). */
  chips?: readonly MapChip[];
  /**
   * Model picker for the model-field chips. Rendered as a second chip row
   * only when given; `activeModel` is an Open-Meteo model id.
   */
  models?: readonly MapModel[];
  activeModel?: string;
  onModelChange?: (modelId: string) => void;
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
  chips = MAP_CHIPS,
  models,
  activeModel,
  onModelChange,
}: WeatherLayerPanelProps) {
  const handleSelect = useCallback(
    (id: string) => {
      if (id === activeLayer) return;
      onLayerChange(id);
      trackEvent("map_layer_changed", { layer: id, location: locationSlug });
    },
    [activeLayer, onLayerChange, locationSlug],
  );

  const chipRow = (
    <div
      role="group"
      aria-label="Map layers"
      className="scrollbar-hide scroll-fade-x -mx-4 flex gap-2 overflow-x-auto px-4 pb-1"
    >
      {chips.map((chip) => {
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

  if (!models || models.length === 0 || !onModelChange) return chipRow;

  return (
    <>
      {chipRow}
      <div
        role="group"
        aria-label="Forecast model"
        className="scrollbar-hide scroll-fade-x -mx-4 mt-1 flex gap-2 overflow-x-auto px-4 pb-1"
      >
        {models.map((model) => {
          const isActive = model.id === activeModel;
          return (
            <button
              key={model.id}
              type="button"
              onClick={() => {
                if (!isActive) onModelChange(model.id);
              }}
              aria-pressed={isActive}
              className={cn(
                "quail shrink-0 px-4 text-sm font-medium",
                isActive && "font-semibold",
              )}
            >
              {model.label}
            </button>
          );
        })}
      </div>
    </>
  );
}

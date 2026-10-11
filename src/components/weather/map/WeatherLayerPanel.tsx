"use client";

import { useCallback } from "react";
import { MAP_CHIPS, type MapChip } from "@/lib/map-layers";
import type { MapModel } from "@/lib/map-sources";
import { cn } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";

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
      className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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

  if (!models || models.length === 0 || !onModelChange) return chipRow;

  return (
    <>
      {chipRow}
      <div
        role="group"
        aria-label="Forecast model"
        className="mt-1 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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

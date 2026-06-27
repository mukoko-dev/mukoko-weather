"use client";

import { useCallback } from "react";
import { MAP_LAYERS } from "@/lib/map-layers";
import { cn } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";

interface WeatherLayerPanelProps {
  activeLayer: string | null;
  onLayerChange: (layerId: string | null) => void;
  locationSlug: string;
}

export function WeatherLayerPanel({
  activeLayer,
  onLayerChange,
  locationSlug,
}: WeatherLayerPanelProps) {
  const handleSelect = useCallback(
    (id: string) => {
      const next = activeLayer === id ? null : id;
      onLayerChange(next);
      if (next) trackEvent("map_layer_changed", { layer: next, location: locationSlug });
    },
    [activeLayer, onLayerChange, locationSlug],
  );

  return (
    <div
      className="pointer-events-auto flex flex-col gap-1 rounded-[var(--radius-card)] border border-primary/10 bg-surface-card/90 p-2 shadow-lg backdrop-blur-sm"
      role="group"
      aria-label="Weather overlay layers"
    >
      <p className="hidden px-2 pb-1 text-xs font-semibold uppercase tracking-wider text-text-tertiary sm:block">
        Overlay
      </p>
      {MAP_LAYERS.map((layer) => {
        const isActive = activeLayer === layer.id;
        return (
          <button
            key={layer.id}
            type="button"
            onClick={() => handleSelect(layer.id)}
            aria-pressed={isActive}
            aria-label={layer.description}
            className={cn(
              "flex min-h-[var(--touch-target-min)] items-center gap-2 rounded-[var(--radius-button)] px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? layer.style.badge
                : "text-text-secondary hover:bg-surface-dim hover:text-text-primary",
            )}
          >
            <span
              className={cn(
                "inline-block h-2.5 w-2.5 shrink-0 rounded-full",
                isActive ? "bg-current" : layer.style.text,
              )}
              aria-hidden="true"
            />
            <span className="hidden sm:inline">{layer.label}</span>
          </button>
        );
      })}
      {activeLayer && (
        <button
          type="button"
          onClick={() => onLayerChange(null)}
          className="mt-1 rounded-[var(--radius-button)] px-3 py-1.5 text-xs text-text-tertiary transition-colors hover:bg-surface-dim hover:text-text-secondary"
        >
          Clear
        </button>
      )}
    </div>
  );
}

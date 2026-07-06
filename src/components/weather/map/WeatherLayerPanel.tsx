"use client";

import { useCallback } from "react";
import { CloudRain, Cloud, Thermometer, Wind, Droplets, Ban, type LucideIcon } from "lucide-react";
import { MAP_LAYERS } from "@/lib/map-layers";
import { cn } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";

interface WeatherLayerPanelProps {
  activeLayer: string | null;
  onLayerChange: (layerId: string | null) => void;
  locationSlug: string;
}

/** Map a MapLayer.icon name → its lucide-react component. */
const LAYER_ICONS: Record<string, LucideIcon> = {
  CloudRain,
  Cloud,
  Thermometer,
  Wind,
  Droplets,
};

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

  const activeMeta = MAP_LAYERS.find((l) => l.id === activeLayer);

  return (
    <div
      className="pointer-events-auto flex flex-col items-center gap-1 rounded-[var(--radius-card)] border border-primary/10 bg-surface-card/90 p-1.5 shadow-lg backdrop-blur-sm"
      role="group"
      aria-label="Weather overlay layers"
    >
      {MAP_LAYERS.map((layer) => {
        const isActive = activeLayer === layer.id;
        const Icon = LAYER_ICONS[layer.icon] ?? Cloud;
        return (
          <button
            key={layer.id}
            type="button"
            onClick={() => handleSelect(layer.id)}
            aria-pressed={isActive}
            aria-label={layer.description}
            title={layer.label}
            className={cn(
              "flex h-[var(--touch-target-min)] w-[var(--touch-target-min)] items-center justify-center rounded-[var(--radius-button)] transition-colors",
              isActive
                ? layer.style.badge
                : "text-text-secondary hover:bg-surface-dim hover:text-text-primary",
            )}
          >
            <Icon className="h-5 w-5" aria-hidden="true" />
          </button>
        );
      })}

      {/* Clear / no overlay */}
      <button
        type="button"
        onClick={() => onLayerChange(null)}
        aria-pressed={activeLayer === null}
        aria-label="No overlay"
        title="No overlay"
        disabled={activeLayer === null}
        className={cn(
          "flex h-[var(--touch-target-min)] w-[var(--touch-target-min)] items-center justify-center rounded-[var(--radius-button)] transition-colors",
          activeLayer === null
            ? "bg-surface-dim text-text-tertiary"
            : "text-text-tertiary hover:bg-surface-dim hover:text-text-secondary",
        )}
      >
        <Ban className="h-5 w-5" aria-hidden="true" />
      </button>

      {/* Tiny caption of the active layer, so the icon meaning is discoverable
          without relying on hover (touch devices have no hover). */}
      <span
        className="max-w-[3.25rem] pt-0.5 text-center text-[0.625rem] font-medium leading-tight text-text-tertiary"
        aria-hidden="true"
      >
        {activeMeta ? activeMeta.label : "Off"}
      </span>
    </div>
  );
}

"use client";

import { useCallback } from "react";
import { MAP_LAYERS } from "@/lib/map-layers";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { trackEvent } from "@/lib/analytics";

interface MapLayerSwitcherProps {
  activeLayer: string;
  onLayerChange: (layerId: string) => void;
  locationSlug: string;
}

export function MapLayerSwitcher({
  activeLayer,
  onLayerChange,
  locationSlug,
}: MapLayerSwitcherProps) {
  const handleLayerChange = useCallback(
    (val: string) => {
      if (!val) return;
      onLayerChange(val);
      trackEvent("map_layer_changed", { layer: val, location: locationSlug });
    },
    [onLayerChange, locationSlug],
  );

  return (
    <ToggleGroup
      type="single"
      value={activeLayer}
      onValueChange={handleLayerChange}
      variant="unstyled"
      className="flex gap-2 overflow-x-auto px-4 py-2 scrollbar-hide [overscroll-behavior-x:contain]"
      aria-label="Map layer selection"
    >
      {MAP_LAYERS.map((layer) => (
        <ToggleGroupItem
          key={layer.id}
          value={layer.id}
          aria-label={layer.description}
          className={cn(
            "shrink-0 rounded-[var(--radius-badge)] px-4 py-2 min-h-[48px] text-base font-medium transition-colors",
            activeLayer === layer.id
              ? layer.style.badge
              : "bg-surface-base text-text-secondary hover:text-text-primary",
          )}
        >
          {layer.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

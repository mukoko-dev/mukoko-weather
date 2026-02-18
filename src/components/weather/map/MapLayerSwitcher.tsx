"use client";

import { MAP_LAYERS, type MapLayer } from "@/lib/map-layers";

interface MapLayerSwitcherProps {
  activeLayer: string;
  onLayerChange: (layerId: string) => void;
}

export function MapLayerSwitcher({
  activeLayer,
  onLayerChange,
}: MapLayerSwitcherProps) {
  return (
    <div
      className="flex gap-2 overflow-x-auto px-4 py-2 scrollbar-hide"
      role="radiogroup"
      aria-label="Map layer selection"
    >
      {MAP_LAYERS.map((layer) => (
        <LayerButton
          key={layer.id}
          layer={layer}
          active={activeLayer === layer.id}
          onClick={() => onLayerChange(layer.id)}
        />
      ))}
    </div>
  );
}

function LayerButton({
  layer,
  active,
  onClick,
}: {
  layer: MapLayer;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="radio"
      aria-checked={active}
      aria-label={layer.description}
      onClick={onClick}
      className={`shrink-0 rounded-[var(--radius-badge)] px-4 py-2 min-h-[44px] text-sm font-medium transition-colors ${
        active
          ? layer.style.badge
          : "bg-surface-base text-text-secondary hover:text-text-primary"
      }`}
      type="button"
    >
      {layer.label}
    </button>
  );
}

"use client";

import {
  createElement,
  useCallback,
  useEffect,
  useRef,
  type FocusEvent,
} from "react";
import {
  Cloud,
  CloudRain,
  Droplets,
  Flame,
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
  WILDFIRE_LAYER_ID,
  type MapChip,
} from "@/lib/map-layers";
import type { MapModel } from "@/lib/map-sources";
import { cn, getScrollBehavior } from "@/lib/utils";
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
  [WILDFIRE_LAYER_ID]: Flame,
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

/**
 * Keeps a focused chip inside its sideways-scrolling row. The browser only
 * scrolls a focused chip into view when it is wholly out of sight: one that is
 * half visible (the Cloud chip, or Wildfires on a wide sheet) stays half
 * hidden under the edge fade, so a keyboard user would tab to a chip they
 * cannot read. `inline: "nearest"` brings it in by the least distance and
 * honours the row's scroll padding; `block: "nearest"` never moves the sheet.
 * Reduced motion jumps instead of gliding.
 */
export function scrollChipIntoView(event: FocusEvent<HTMLButtonElement>) {
  event.currentTarget.scrollIntoView({
    inline: "nearest",
    block: "nearest",
    behavior: getScrollBehavior(),
  });
}

/**
 * How far to scroll a chip row sideways (CSS px, forward positive) so a chip
 * sits wholly inside it, clear of the row's own padding at both ends (the edge
 * fade at the end). 0 when it already does. Pure: boxes are `getBoundingClientRect`
 * edges, the insets the row's padding.
 */
export function chipScrollDelta(
  row: { left: number; right: number },
  chip: { left: number; right: number },
  inset: { start: number; end: number },
): number {
  const past = chip.right - (row.right - inset.end);
  if (past > 0) return past;
  const before = row.left + inset.start - chip.left;
  return before > 0 ? -before : 0;
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
 * 49px-minimum touch target (`--touch-target-min`).
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

  // Brings the active chip into view when the layer changes and when the panel
  // first shows: the layer the map opens on (Satellite) is the sixth chip,
  // off screen on a phone, so the visitor would see no chip selected. Only the
  // row moves (never the sheet), without animation the first time.
  const layerRow = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  useEffect(() => {
    const row = layerRow.current;
    const chip = row?.querySelector<HTMLElement>('[aria-pressed="true"]');
    if (!row || !chip) return;
    const pad = getComputedStyle(row);
    const delta = chipScrollDelta(
      row.getBoundingClientRect(),
      chip.getBoundingClientRect(),
      {
        start: parseFloat(pad.paddingInlineStart) || 0,
        end: parseFloat(pad.paddingInlineEnd) || 0,
      },
    );
    if (delta !== 0) {
      row.scrollBy({
        left: delta,
        behavior: placed.current ? getScrollBehavior() : "instant",
      });
    }
    placed.current = true;
  }, [activeLayer]);

  const chipRow = (
    <div
      ref={layerRow}
      role="group"
      aria-label="Map layers"
      // mzizi-spacing-exempt: full-bleed sideways scroller; -mx-4 reaches into the sheet's own padding (ps-4 puts it back at the start, pe-6 clears the 1.5rem edge fade at the end) so chips scroll to the card's edge and overlap no target
      className="scrollbar-hide scroll-fade-x scroll-px-6 -mx-4 flex gap-2 overflow-x-auto ps-4 pe-6 pb-1"
    >
      {chips.map((chip) => {
        const isActive = chip.id === activeLayer;
        return (
          <button
            key={chip.id}
            type="button"
            onClick={() => handleSelect(chip.id)}
            onFocus={scrollChipIntoView}
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
        // mzizi-spacing-exempt: the same full-bleed sideways scroller as the layer chips above
        className="scrollbar-hide scroll-fade-x scroll-px-6 -mx-4 mt-1 flex gap-2 overflow-x-auto ps-4 pe-6 pb-1"
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
              onFocus={scrollChipIntoView}
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

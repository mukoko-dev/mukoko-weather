import * as React from "react";
import { trackWindow } from "@/lib/scale-blend";
import { blendGradient, clampPct, type GradientPreset } from "./geometry";

export interface GradientScaleProps {
  /** Marker position along the scale, 0–100. */
  positionPct: number;
  /** A preset ramp or explicit CSS custom-property names (e.g. "--wx-uv-1"). */
  stops: GradientPreset | readonly string[];
  /** Optional sub-range (e.g. a day's low→high). The gradient still spans 0–100. */
  rangeStartPct?: number;
  rangeEndPct?: number;
  /** Accessible name for the scale. */
  label?: string;
}

/**
 * Horizontal bar that BLENDS from the low end to the high end, with a round
 * marker at the value. The bar is one smooth gradient built from the scale's
 * own `--wx-*` tokens (colour is shown unmixed at the middle of each band, see
 * `blendStops`), so there are no seams and the colours stay the ones people
 * expect for this quantity.
 *
 * Size is fixed by tokens (`--wx-scale-track-height`, `--wx-scale-marker-size`,
 * `--wx-scale-max-width`), never a share of the card's width: the same thin
 * bar and small marker on a phone and on a wide desktop card, left aligned and
 * capped. The track carries the `--wx-outline` ring (non-text contrast, 3:1)
 * and the marker is an outlined dot (surface fill, text-coloured ring) so it
 * stays visible on any stop.
 *
 * Plain HTML and CSS rather than SVG: the gradient reads the CSS variables
 * directly, so it follows the light/dark theme with no script and no flash of
 * unresolved colour while hydrating.
 */
export function GradientScale({
  positionPct,
  stops,
  rangeStartPct,
  rangeEndPct,
  label = "Scale",
}: GradientScaleProps) {
  const pos = clampPct(positionPct);
  const gradient = blendGradient(stops);
  const hasRange = rangeStartPct != null && rangeEndPct != null;
  const win = hasRange ? trackWindow(rangeStartPct, rangeEndPct) : null;

  return (
    <div
      role="img"
      aria-label={`${label}: ${Math.round(pos)}% along the scale`}
      className="w-full max-w-[var(--wx-scale-max-width)] px-[calc(var(--wx-scale-marker-size)/2)]"
    >
      {/* The span the marker travels: its ends are the ends of the track, so
          the marker's left edge is exactly the value's position. */}
      <div className="relative flex h-[var(--wx-scale-marker-size)] items-center">
        {/* Track: the quiet fill shows if a browser drops the gradient */}
        <div className="relative h-[var(--wx-scale-track-height)] w-full rounded-full bg-text-tertiary/15 ring-1 ring-wx-outline">
          {win ? (
            <div
              className="absolute inset-y-0 overflow-hidden rounded-full"
              style={{ left: `${win.left}%`, width: `${win.width}%` }}
              data-range-window
            >
              <div
                className="absolute inset-y-0"
                style={{
                  left: `${win.innerLeft}%`,
                  width: `${win.innerWidth}%`,
                  backgroundImage: gradient,
                }}
              />
            </div>
          ) : (
            <div
              className="absolute inset-0 rounded-full"
              style={{ backgroundImage: gradient }}
              data-gradient
            />
          )}
        </div>
        {/* Marker: outlined dot, readable on any stop */}
        <span
          aria-hidden="true"
          className="absolute top-1/2 size-[var(--wx-scale-marker-size)] -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-text-primary bg-surface-card"
          style={{ left: `${pos}%` }}
          data-marker-pct={pos}
        />
      </div>
    </div>
  );
}

export interface ScaleReadoutProps {
  /** Big number shown above the bar, e.g. an AQI of 114. */
  value: string | number;
  /** Level text, e.g. "Unhealthy". */
  label: string;
  positionPct: number;
  preset: GradientPreset;
}

/** Apple-style readout: big value, level word, coloured scale underneath. */
export function ScaleReadout({
  value,
  label,
  positionPct,
  preset,
}: ScaleReadoutProps) {
  return (
    <div className="flex w-full flex-col gap-2">
      <p className="text-4xl font-bold leading-none tabular-nums text-text-primary">
        {value}
      </p>
      <p className="giraffe">{label}</p>
      <GradientScale positionPct={positionPct} stops={preset} label={label} />
    </div>
  );
}

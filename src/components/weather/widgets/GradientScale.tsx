"use client";

import * as React from "react";
import { clampPct, gradientTokens, type GradientPreset } from "./geometry";
import { useResolvedColors } from "./use-resolved-colors";

export interface GradientScaleProps {
  /** Marker position along the scale, 0–100. */
  positionPct: number;
  /** A preset ramp or explicit CSS custom-property names (e.g. "--color-severity-low"). */
  stops: GradientPreset | readonly string[];
  /** Optional sub-range (e.g. a day's low→high). The gradient still spans 0–100. */
  rangeStartPct?: number;
  rangeEndPct?: number;
  /** Accessible name for the scale. */
  label?: string;
}

/**
 * Horizontal multi-colour bar with a dot marker. The marker is an outlined
 * dot (surface fill, text-coloured ring) so it stays visible on any stop.
 */
export function GradientScale({
  positionPct,
  stops,
  rangeStartPct,
  rangeEndPct,
  label = "Scale",
}: GradientScaleProps) {
  const tokens = React.useMemo(() => gradientTokens(stops), [stops]);
  const colors = useResolvedColors(tokens);
  const rawId = React.useId();
  const gradientId = `grad-scale-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const pos = clampPct(positionPct);
  const hasRange = rangeStartPct != null && rangeEndPct != null;
  const rStart = hasRange ? clampPct(Math.min(rangeStartPct, rangeEndPct)) : 0;
  const rEnd = hasRange ? clampPct(Math.max(rangeStartPct, rangeEndPct)) : 100;
  const ramp = colors.length > 0 ? colors : tokens;

  return (
    <svg
      viewBox="-6 -2 112 16"
      className="h-auto w-full"
      role="img"
      aria-label={`${label}: ${Math.round(pos)}% along the scale`}
    >
      <defs>
        <linearGradient
          id={gradientId}
          gradientUnits="userSpaceOnUse"
          x1={0}
          y1={0}
          x2={100}
          y2={0}
        >
          {ramp.map((c, i) => (
            <stop
              key={i}
              offset={ramp.length === 1 ? 1 : i / (ramp.length - 1)}
              stopColor={c}
            />
          ))}
        </linearGradient>
      </defs>
      {/* Track */}
      <rect
        x={0}
        y={3}
        width={100}
        height={6}
        rx={3}
        className="fill-text-tertiary/15"
      />
      {/* Coloured bar (full span, or the sub-range) */}
      <rect
        x={rStart}
        y={3}
        width={Math.max(0, rEnd - rStart)}
        height={6}
        rx={3}
        fill={`url(#${gradientId})`}
      />
      {/* Marker: outlined dot, readable on any stop */}
      <circle
        cx={pos}
        cy={6}
        r={4.6}
        strokeWidth={1.6}
        className="fill-surface-card stroke-text-primary"
        data-marker-cx={pos}
      />
    </svg>
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

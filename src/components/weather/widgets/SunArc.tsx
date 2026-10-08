import * as React from "react";
import {
  clampPct,
  sunArcPath,
  sunArcPoint,
  sunArcSegmentPath,
} from "./geometry";

export interface SunArcProps {
  /** Position of the sun between sunrise (0) and sunset (100). null = night. */
  arcPct: number | null;
  sunrise: string;
  sunset: string;
}

const W = 200;
const H = 80;

/**
 * Sunrise→sunset path. Travelled part is drawn in the severity-moderate
 * colour; the remainder is dim. At night the marker sits on the horizon's
 * right end, below the line, and is dimmed.
 */
export function SunArc({ arcPct, sunrise, sunset }: SunArcProps) {
  const isNight = arcPct == null;
  const t = isNight ? 1 : clampPct(arcPct) / 100;
  const marker = isNight ? { x: W, y: H + 8 } : sunArcPoint(W, H, t);
  const status = isNight
    ? "night"
    : `${Math.round(clampPct(arcPct))}% of daylight travelled`;

  return (
    <svg
      viewBox={`-6 0 ${W + 12} 100`}
      className="h-auto w-full"
      role="img"
      aria-label={`Sun: sunrise ${sunrise}, sunset ${sunset}, ${status}`}
    >
      <line
        x1={0}
        y1={H}
        x2={W}
        y2={H}
        strokeWidth={1}
        className="stroke-text-tertiary/30"
      />
      <path
        d={sunArcPath(W, H)}
        fill="none"
        strokeWidth={2}
        strokeDasharray="3 4"
        className="stroke-text-tertiary/40"
      />
      {!isNight && (
        <path
          d={sunArcSegmentPath(W, H, t)}
          fill="none"
          strokeWidth={3}
          strokeLinecap="round"
          className="stroke-severity-moderate"
        />
      )}
      <circle
        cx={marker.x}
        cy={marker.y}
        r={6}
        className={isNight ? "fill-text-tertiary/50" : "fill-severity-moderate"}
        data-sun-x={marker.x}
        data-sun-y={marker.y}
      />
      <text
        x={0}
        y={H + 18}
        textAnchor="start"
        className="fill-text-tertiary text-[11px]"
        aria-hidden="true"
      >
        {sunrise}
      </text>
      <text
        x={W}
        y={H + 18}
        textAnchor="end"
        className="fill-text-tertiary text-[11px]"
        aria-hidden="true"
      >
        {sunset}
      </text>
    </svg>
  );
}

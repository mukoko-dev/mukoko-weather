import * as React from "react";
import { barHeights } from "./geometry";

export interface MiniBarsProps {
  values: number[];
  /** Value that maps to a full-height bar. Defaults to the series maximum. */
  max?: number;
  /** Index of the bar to emphasise (e.g. "now"). */
  highlightIndex?: number;
  /** Accessible description, e.g. "Rain next 6 hours". */
  label?: string;
}

const VB_W = 100;
const VB_H = 40;

/** Tiny bar sparkline for short series such as next-hours precipitation. */
export function MiniBars({
  values,
  max,
  highlightIndex,
  label = "Bar chart",
}: MiniBarsProps) {
  const heights = barHeights(values, max);
  const n = heights.length || 1;
  const slot = VB_W / n;
  const bar = slot * 0.7;

  return (
    <svg
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      className="h-auto w-full"
      role="img"
      aria-label={`${label}: ${values.length} values`}
    >
      {heights.map((h, i) => {
        const height = Math.max(1, (h / 100) * VB_H);
        return (
          <rect
            key={i}
            x={i * slot + (slot - bar) / 2}
            y={VB_H - height}
            width={bar}
            height={height}
            rx={1.2}
            className={
              i === highlightIndex ? "fill-primary" : "fill-primary/35"
            }
          />
        );
      })}
    </svg>
  );
}

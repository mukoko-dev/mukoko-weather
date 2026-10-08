import * as React from "react";
import { compassPoint, compassTicks, windAriaLabel } from "./geometry";

export interface CompassDialProps {
  /** Bearing the wind blows FROM, degrees (0 = north, meteorological convention). */
  directionDeg: number;
  /** Sustained wind speed. */
  speed: number;
  /** Speed unit label. */
  unit?: string;
  /** Optional gust speed, shown under the sustained speed. */
  gust?: number;
}

const CENTER = 50;
const RING = 40;

/**
 * Wind compass. The ring carries 10° ticks (30° majors) and cardinal labels.
 * The needle's tail sits on the FROM side of the ring and its head points to
 * where the air is going, so the group rotates by exactly `directionDeg`.
 */
export function CompassDial({
  directionDeg,
  speed,
  unit = "km/h",
  gust,
}: CompassDialProps) {
  const ticks = compassTicks(CENTER, CENTER, RING, 10, 30);
  const dir = ((directionDeg % 360) + 360) % 360;
  const cardinals: Array<{ label: string; x: number; y: number }> = [
    { label: "N", x: CENTER, y: CENTER - RING - 6 },
    { label: "E", x: CENTER + RING + 6, y: CENTER },
    { label: "S", x: CENTER, y: CENTER + RING + 6 },
    { label: "W", x: CENTER - RING - 6, y: CENTER },
  ];

  return (
    <svg
      viewBox="-12 -12 124 124"
      className="h-auto w-full max-w-[var(--size-insight-dial-max)] text-primary"
      role="img"
      aria-label={windAriaLabel(dir, speed, unit, gust)}
      data-compass-point={compassPoint(dir)}
    >
      {ticks.map((t, i) => (
        <line
          key={i}
          x1={t.x1}
          y1={t.y1}
          x2={t.x2}
          y2={t.y2}
          strokeWidth={t.major ? 1.4 : 0.6}
          className={
            t.major ? "stroke-text-secondary" : "stroke-text-tertiary/60"
          }
          strokeLinecap="round"
        />
      ))}
      {cardinals.map((c) => (
        <text
          key={c.label}
          x={c.x}
          y={c.y}
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-text-secondary text-[7px] font-semibold"
          aria-hidden="true"
        >
          {c.label}
        </text>
      ))}
      {/* Needle: tail on the FROM side (top before rotation), head toward TO. */}
      <g
        transform={`rotate(${dir} ${CENTER} ${CENTER})`}
        data-needle-rotation={dir}
      >
        <line
          x1={CENTER}
          y1={CENTER - RING + 8}
          x2={CENTER}
          y2={CENTER + 8}
          strokeWidth={2.4}
          strokeLinecap="round"
          className="stroke-primary"
        />
        <circle
          cx={CENTER}
          cy={CENTER - RING + 8}
          r={2.6}
          className="fill-primary"
        />
        <polygon
          points={`${CENTER},${CENTER + 16} ${CENTER - 5},${CENTER + 6} ${CENTER + 5},${CENTER + 6}`}
          className="fill-primary"
        />
      </g>
      <text
        x={CENTER}
        y={CENTER - 3}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-text-primary text-[13px] font-bold tabular-nums [paint-order:stroke] stroke-surface-card stroke-[3px]"
        aria-hidden="true"
      >
        {speed}
      </text>
      <text
        x={CENTER}
        y={CENTER + 7}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-text-tertiary text-[5.5px] [paint-order:stroke] stroke-surface-card stroke-[2px]"
        aria-hidden="true"
      >
        {gust != null ? `${unit} · gusts ${gust}` : unit}
      </text>
    </svg>
  );
}

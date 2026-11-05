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
 * Where the four cardinal letters sit, as a share of the dial's square (the
 * viewBox runs -12 to 112 on both axes, so a point at (x, y) is at
 * ((x + 12) / 124) of the width and height; the letters are 50 units from the
 * centre, 10 outside the ring).
 */
const CARDINALS: Array<{ label: string; place: string }> = [
  { label: "N", place: "left-1/2 top-[9.7%]" },
  { label: "E", place: "left-[90.3%] top-1/2" },
  { label: "S", place: "left-1/2 top-[90.3%]" },
  { label: "W", place: "left-[9.7%] top-1/2" },
];

/**
 * Wind compass. The ring carries 10° ticks (30° majors). The needle's tail
 * sits on the FROM side of the ring and its head points to where the air is
 * going, so the group rotates by exactly `directionDeg`.
 *
 * The cardinal letters and the speed are HTML over and under the ring, not SVG
 * text: SVG text is sized in the viewBox's units and scales with the tile (a
 * 10px letter drew at about 9px in a phone-width tile), while the Bundu floor
 * is 14px as drawn (stage 2 of #479).
 */
export function CompassDial({
  directionDeg,
  speed,
  unit = "km/h",
  gust,
}: CompassDialProps) {
  const ticks = compassTicks(CENTER, CENTER, RING, 10, 30);
  const dir = ((directionDeg % 360) + 360) % 360;

  return (
    <div className="flex w-full max-w-[var(--size-insight-dial-max)] flex-col items-center gap-[var(--gap-floor)]">
      <div className="relative w-full">
        <svg
          viewBox="-12 -12 124 124"
          className="h-auto w-full text-primary"
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
        </svg>
        {CARDINALS.map((c) => (
          <span
            key={c.label}
            aria-hidden="true"
            className={`absolute -translate-x-1/2 -translate-y-1/2 text-sm font-semibold text-text-secondary ${c.place}`}
          >
            {c.label}
          </span>
        ))}
      </div>
      <p className="text-center text-sm text-text-tertiary" aria-hidden="true">
        <span className="font-bold tabular-nums text-text-primary">
          {speed}
        </span>{" "}
        {unit}
        {gust != null ? ` · gusts ${gust}` : ""}
      </p>
    </div>
  );
}

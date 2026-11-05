import * as React from "react";
import { arcPoint, fractionOf, trendGlyph } from "./geometry";

export interface PressureDialProps {
  hPa: number;
  trend: "rising" | "falling" | "steady";
  min?: number;
  max?: number;
}

const CX = 60;
const CY = 60;
const R = 46;

/**
 * Barometer: upper-semicircle arc with 10 hPa ticks and a needle; the scale
 * ends, value and trend are HTML under it (SVG text scales with the tile, and
 * the Bundu floor is 14px as drawn: stage 2 of #479).
 */
export function PressureDial({
  hPa,
  trend,
  min = 960,
  max = 1050,
}: PressureDialProps) {
  const f = fractionOf(hPa, min, max);
  const needle = arcPoint(CX, CY, R - 10, f);
  const ticks: React.ReactNode[] = [];
  for (let v = min; v <= max; v += 10) {
    const fr = fractionOf(v, min, max);
    const a = arcPoint(CX, CY, R + 1, fr);
    const b = arcPoint(CX, CY, R - 5, fr);
    ticks.push(
      <line
        key={v}
        x1={a.x}
        y1={a.y}
        x2={b.x}
        y2={b.y}
        strokeWidth={1}
        className="stroke-text-tertiary/60"
      />,
    );
  }
  const start = arcPoint(CX, CY, R, 0);
  const end = arcPoint(CX, CY, R, 1);
  const track = `M ${start.x} ${start.y} A ${R} ${R} 0 0 1 ${end.x} ${end.y}`;

  return (
    <div className="flex w-full max-w-[var(--size-insight-dial-max)] flex-col gap-[var(--gap-floor)]">
      <svg
        viewBox="0 8 120 58"
        className="h-auto w-full"
        role="img"
        aria-label={`Pressure ${Math.round(hPa)} hPa, ${trend}`}
      >
        <path
          d={track}
          fill="none"
          strokeWidth={4}
          strokeLinecap="round"
          className="stroke-text-tertiary/20"
        />
        {ticks}
        <line
          x1={CX}
          y1={CY}
          x2={needle.x}
          y2={needle.y}
          strokeWidth={2.2}
          strokeLinecap="round"
          className="stroke-primary"
        />
        <circle cx={CX} cy={CY} r={3} className="fill-primary" />
      </svg>
      <div className="flex flex-col items-center" aria-hidden="true">
        <p className="flex w-full justify-between text-sm text-text-tertiary tabular-nums">
          <span>{min}</span>
          <span>{max}</span>
        </p>
        <p className="text-sm font-bold tabular-nums text-text-primary">
          {Math.round(hPa)}{" "}
          <span className="font-normal text-text-tertiary">hPa</span>{" "}
          <span className="font-normal text-text-secondary">
            {trendGlyph(trend)}
          </span>
        </p>
      </div>
    </div>
  );
}

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

/** Barometer: upper-semicircle arc with 10 hPa ticks, needle, value and trend. */
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
    <svg
      viewBox="0 0 120 96"
      className="h-auto w-full max-w-[var(--size-insight-dial-max)]"
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
      <text
        x={12}
        y={76}
        textAnchor="middle"
        className="fill-text-tertiary text-[7px]"
        aria-hidden="true"
      >
        {min}
      </text>
      <text
        x={108}
        y={76}
        textAnchor="middle"
        className="fill-text-tertiary text-[7px]"
        aria-hidden="true"
      >
        {max}
      </text>
      <text
        x={CX}
        y={84}
        textAnchor="middle"
        dominantBaseline="middle"
        className="fill-text-primary text-[13px] font-bold tabular-nums"
        aria-hidden="true"
      >
        {Math.round(hPa)}
        <tspan className="text-[6px] font-normal fill-text-tertiary">
          {" "}
          hPa{" "}
        </tspan>
        <tspan className="fill-text-secondary">{trendGlyph(trend)}</tspan>
      </text>
    </svg>
  );
}

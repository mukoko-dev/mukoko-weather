"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  HERO_CURVE_BOX,
  HERO_CURVE_DEFAULT_WIDTH,
  heroDayCurve,
  type HeroCurveLabel,
} from "@/lib/hero-card";
import type { HourlyWeather } from "@/lib/weather";
import { HERO_CURVE_CLASS } from "./hero-card-classes";

/** What the curve is drawn from (the hero's clock has to be known first). */
export interface HeroCurveSource {
  hourly: HourlyWeather | undefined;
  now: Date;
  offsetSeconds: number | undefined;
  /** The hero numeral: the curve's first point, so "now" matches it. */
  nowTemperature: number;
}

/**
 * One label on the curve (the only SVG text element in the file).
 * The component sets the SVG's viewBox to the element's measured width and
 * its height to the box in px, so one unit is one CSS px: the label is drawn
 * at the --text-caption size (14px, the text floor) at every phone width and
 * is never scaled with a viewBox.
 */
function CurveLabel({
  label,
  className,
}: {
  label: HeroCurveLabel;
  className: string;
}) {
  return (
    // mzizi-text-exempt: 1 unit is 1 CSS px here (the viewBox is the measured width), so the size is the --text-caption token at 14px and is not scaled
    <text
      x={label.x}
      y={label.y}
      textAnchor={label.anchor}
      className={`text-[length:var(--text-caption)] tabular-nums ${className}`}
    >
      {label.text}
    </text>
  );
}

/** Halo so a label stays readable where the line passes behind it. */
const VALUE_LABEL =
  "fill-text-primary stroke-surface-card stroke-[3px] font-semibold [paint-order:stroke]";
const TICK_LABEL = "fill-text-secondary";

/**
 * The 24-hour temperature curve of the hero's data card: the line, a soft fill
 * under it, a tick and clock label every six hours, the now dot and the low
 * marker. One sentence is its accessible name (the picture adds nothing a
 * screen reader does not get from it).
 *
 * `source` is null until the hero knows the place's clock (after mount): with
 * `reserve` it holds the curve's height as an empty, hidden drawing so the
 * card does not grow when the curve arrives; without it nothing is drawn. A
 * series that cannot be drawn (missing, stale, fewer than four readable
 * hours) draws nothing at all, never an empty frame.
 */
export function HeroDayCurve({
  source,
  reserve,
}: {
  source: HeroCurveSource | null;
  reserve: boolean;
}) {
  const gradientId = `hero-curve-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({
    width: HERO_CURVE_DEFAULT_WIDTH,
    scale: 1,
  });

  const curve = useMemo(
    () =>
      source
        ? heroDayCurve(
            source.hourly,
            source.now,
            source.offsetSeconds,
            source.nowTemperature,
            size,
          )
        : null,
    [source, size],
  );

  // The element exists while there is a curve or its reserved height.
  const rendered = curve !== null || (reserve && source === null);

  // 1 unit = 1 CSS px: the viewBox is the element's own width, and the box's
  // height grows with the root font size (the visitor's text size).
  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    const measure = () => {
      const width = Math.round(svg.getBoundingClientRect().width);
      const root = parseFloat(
        getComputedStyle(document.documentElement).fontSize,
      );
      const scale = Number.isFinite(root) && root > 0 ? root / 16 : 1;
      setSize((prev) =>
        width <= 0 || (prev.width === width && prev.scale === scale)
          ? prev
          : { width, scale },
      );
    };
    const frame = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(svg);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [rendered]);

  if (!curve) {
    if (!reserve || source) return null;
    // Before the clock: the curve's height, drawn as nothing.
    return (
      <svg
        ref={ref}
        aria-hidden="true"
        focusable="false"
        className={HERO_CURVE_CLASS}
        width="100%"
        height={HERO_CURVE_BOX.height * size.scale}
        viewBox={`0 0 ${size.width} ${HERO_CURVE_BOX.height * size.scale}`}
      />
    );
  }

  return (
    <svg
      ref={ref}
      role="img"
      aria-label={curve.ariaLabel}
      focusable="false"
      className={HERO_CURVE_CLASS}
      width="100%"
      height={curve.height}
      viewBox={`0 0 ${curve.width} ${curve.height}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop
            offset="0"
            stopColor="var(--color-primary)"
            stopOpacity="0.28"
          />
          <stop offset="1" stopColor="var(--color-primary)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {curve.ticks.map((tick) => (
        <line
          key={tick.x}
          x1={tick.x}
          x2={tick.x}
          y1={tick.y1}
          y2={tick.y2}
          className="stroke-border"
          strokeWidth="1"
        />
      ))}
      <path d={curve.areaPath} fill={`url(#${gradientId})`} />
      <path
        d={curve.linePath}
        className="fill-none stroke-text-primary"
        strokeWidth="2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {curve.ticks.map((tick) => (
        <CurveLabel
          key={`tick-${tick.x}`}
          label={tick.label}
          className={TICK_LABEL}
        />
      ))}
      <circle
        cx={curve.now.x}
        cy={curve.now.y}
        r={curve.now.radius}
        className="fill-primary stroke-surface-card"
        strokeWidth="2"
      />
      <CurveLabel label={curve.now.label} className={VALUE_LABEL} />
      {curve.low && (
        <>
          <circle
            cx={curve.low.x}
            cy={curve.low.y}
            r={curve.low.radius}
            className="fill-surface-card stroke-text-primary"
            strokeWidth="2"
          />
          {curve.low.label && (
            <CurveLabel label={curve.low.label} className={VALUE_LABEL} />
          )}
        </>
      )}
    </svg>
  );
}

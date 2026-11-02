// Pure geometry + formatting helpers for the metric-card visuals.
// No React, no DOM — fully unit-testable from a .test.ts file.

import {
  bandCentreStops,
  blendGradientCss,
  evenStops,
  type BlendStop,
} from "@/lib/scale-blend";
import {
  AQI_SCALE,
  TEMP_SCALE,
  UV_SCALE,
  UV_SCALE_MAX,
} from "@/lib/weather-scales";

export type Point = { x: number; y: number };

/** Point on a circle. Angle in degrees, 0 = top (12 o'clock), clockwise. */
export function polar(cx: number, cy: number, r: number, deg: number): Point {
  const rad = ((deg - 90) * Math.PI) / 180;
  return { x: round(cx + r * Math.cos(rad)), y: round(cy + r * Math.sin(rad)) };
}

export function round(n: number, places = 3): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

const POINTS_16 = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

/** 16-point compass label for a bearing in degrees (0 = N). */
export function compassPoint(deg: number): string {
  const norm = ((deg % 360) + 360) % 360;
  return POINTS_16[Math.round(norm / 22.5) % 16];
}

/** Human wind sentence, e.g. "Wind 5 km/h from the ENE". */
export function windAriaLabel(
  directionDeg: number,
  speed: number,
  unit = "km/h",
  gust?: number,
): string {
  const base = `Wind ${round(speed, 1)} ${unit} from the ${compassPoint(directionDeg)}`;
  return gust != null && Number.isFinite(gust)
    ? `${base}, gusts ${round(gust, 1)} ${unit}`
    : base;
}

export type Tick = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  major: boolean;
};

/** Ring of ticks every `stepDeg`; every `majorDeg` is a major tick. */
export function compassTicks(
  cx: number,
  cy: number,
  rOuter: number,
  stepDeg = 10,
  majorDeg = 30,
): Tick[] {
  const ticks: Tick[] = [];
  for (let deg = 0; deg < 360; deg += stepDeg) {
    const major = deg % majorDeg === 0;
    const inner = rOuter - (major ? rOuter * 0.14 : rOuter * 0.07);
    const a = polar(cx, cy, inner, deg);
    const b = polar(cx, cy, rOuter, deg);
    ticks.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, major });
  }
  return ticks;
}

/**
 * Position of a value along an arc from `min` to `max`, expressed as a
 * fraction 0–1 (clamped). Used by PressureDial.
 */
export function fractionOf(value: number, min: number, max: number): number {
  if (max === min || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

/**
 * Sun arc geometry. The arc runs from the left horizon (x=0, y=h) to the right
 * horizon (x=w, y=h), peaking above the middle. Quadratic Bézier with control
 * point C = (w/2, -0.6h); its highest point is y = 0.4h (inside the viewBox).
 */
export const SUN_ARC_CONTROL_LIFT = 0.6;

export function sunArcPath(w: number, h: number): string {
  return `M 0 ${h} Q ${w / 2} ${round(-h * SUN_ARC_CONTROL_LIFT)} ${w} ${h}`;
}

/** Point on the quadratic sun arc at parameter t (0–1, clamped). */
export function sunArcPoint(w: number, h: number, t: number): Point {
  const k = Math.max(0, Math.min(1, t));
  const cx = w / 2;
  const cy = -h * SUN_ARC_CONTROL_LIFT;
  const x = 2 * (1 - k) * k * cx + k * k * w;
  const y = (1 - k) * (1 - k) * h + 2 * (1 - k) * k * cy + k * k * h;
  return { x: round(x), y: round(y) };
}

/**
 * Path for the travelled part of the sun arc, from t=0 to t. Built by
 * de Casteljau subdivision: the sub-curve keeps P0 and the new end point, with
 * control point lerp(P0, C, t).
 */
export function sunArcSegmentPath(w: number, h: number, t: number): string {
  const k = Math.max(0, Math.min(1, t));
  const end = sunArcPoint(w, h, k);
  const c = { x: w / 2, y: -h * SUN_ARC_CONTROL_LIFT };
  const ctrlX = round((1 - k) * 0 + k * c.x);
  const ctrlY = round((1 - k) * h + k * c.y);
  return `M 0 ${h} Q ${ctrlX} ${ctrlY} ${end.x} ${end.y}`;
}

/**
 * Point on the upper semicircle centred at (cx,cy) for fraction f (0 = left
 * end, 1 = right end). Used by PressureDial.
 */
export function arcPoint(cx: number, cy: number, r: number, f: number): Point {
  const theta = Math.PI * (1 - Math.max(0, Math.min(1, f)));
  return {
    x: round(cx + r * Math.cos(theta)),
    y: round(cy - r * Math.sin(theta)),
  };
}

/**
 * Preset ramps, expressed as CSS custom-property names read off the weather
 * scales (weather-scales.ts), so a bar and the scale's own swatches share one
 * list: WHO UV, the six official EPA AQI colours and the temperature ramp.
 * Never brand minerals or the severity ramp.
 */
export const GRADIENT_PRESETS = {
  uv: UV_SCALE.bands.map((band) => band.token),
  aqi: AQI_SCALE.bands.map((band) => band.token),
  // Every second temperature band: a five-colour ramp, cold to hot.
  temperature: TEMP_SCALE.bands
    .filter((_, i) => i % 2 === 0)
    .map((band) => band.token),
};

export type GradientPreset = keyof typeof GRADIENT_PRESETS;

/**
 * Where each category sits on a bar, as the band EDGES in percent (one more
 * entry than there are tokens). The bar BLENDS: each official colour is shown
 * unmixed at the middle of its band and runs into its neighbours between the
 * middles (`blendStops`). UV runs 0-14 so Extreme (11+) has room; AQI gives
 * each EPA band an equal sixth (see aqiScalePct).
 */
export const GRADIENT_BREAKS: Partial<
  Record<GradientPreset, readonly number[]>
> = {
  uv: [...UV_SCALE.bands.map((band) => band.from), UV_SCALE_MAX].map((v) =>
    round((v / UV_SCALE_MAX) * 100),
  ),
  aqi: [0, 1, 2, 3, 4, 5, 6].map((v) => round((v / 6) * 100)),
};

const CUSTOM_PROP_RE = /^--[a-z0-9-]+$/;

/**
 * Resolve a GradientScale `stops` prop to a list of CSS var() references.
 * Preset names map to their ramp; explicit lists are filtered to safe
 * custom-property names (anything else is dropped, never interpolated raw).
 */
export function gradientTokens(
  stops: GradientPreset | readonly string[],
): string[] {
  const names: readonly string[] =
    typeof stops === "string" ? GRADIENT_PRESETS[stops] : stops;
  const safe = names.filter((n) => CUSTOM_PROP_RE.test(n));
  if (safe.length === 0) return [`var(${GRADIENT_PRESETS.uv[0]})`];
  return safe.map((n) => `var(${n})`);
}

/**
 * Moon terminator geometry. `phase` 0 = new, 0.25 = first quarter (lit right),
 * 0.5 = full, 0.75 = last quarter (lit left). `k = cos(2πφ)` gives the
 * terminator's signed semi-axis as a fraction of the radius.
 */
export function moonTerminatorGeometry(phase: number, r: number) {
  const p = ((phase % 1) + 1) % 1;
  const waxing = p < 0.5;
  const k = Math.cos(2 * Math.PI * p);
  return {
    waxing,
    /** Terminator semi-axis radius (absolute). */
    rx: round(Math.abs(k) * r),
    /** k > 0 → terminator bulges toward the lit side's *inside* (crescent). */
    crescent: k > 0,
  };
}

/**
 * SVG path of the LIT portion of the moon, centred at (0,0), radius r.
 * Northern-hemisphere convention: waxing is lit on the right.
 */
export function moonTerminatorPath(phase: number, r: number): string {
  const { waxing, rx, crescent } = moonTerminatorGeometry(phase, r);
  const p = ((phase % 1) + 1) % 1;
  const k = Math.cos(2 * Math.PI * p);
  // Full moon: lit = whole disc.
  if (Math.abs(k + 1) < 1e-9) {
    return `M 0 ${-r} A ${r} ${r} 0 1 1 0 ${r} A ${r} ${r} 0 1 1 0 ${-r} Z`;
  }
  // New moon: nothing lit.
  if (Math.abs(k - 1) < 1e-9) return "";
  const outerSweep = waxing ? 1 : 0;
  // Terminator sweep: waxing crescent bulges right (sweep 0), gibbous left (1).
  const termSweep = waxing ? (crescent ? 0 : 1) : crescent ? 1 : 0;
  return [
    `M 0 ${-r}`,
    `A ${r} ${r} 0 0 ${outerSweep} 0 ${r}`,
    `A ${rx} ${r} 0 0 ${termSweep} 0 ${-r}`,
    "Z",
  ].join(" ");
}

/** Illumination fraction 0–1 from phase. */
export function illuminationFromPhase(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  return round((1 - Math.cos(2 * Math.PI * p)) / 2, 4);
}

/** Pressure trend arrow glyph. */
export function trendGlyph(trend: "rising" | "falling" | "steady"): string {
  if (trend === "rising") return "↑";
  if (trend === "falling") return "↓";
  return "→";
}

/** Heights (0–100 of viewBox) for MiniBars. */
export function barHeights(values: number[], max?: number): number[] {
  const finite = values.map((v) => (Number.isFinite(v) ? Math.max(0, v) : 0));
  const top = max && max > 0 ? max : Math.max(1e-9, ...finite);
  return finite.map((v) => round(Math.min(1, v / top) * 100, 2));
}

/**
 * The blend for a `stops` prop: a preset with band edges (UV, AQI) puts each
 * colour at the middle of its band; any other ramp spreads its colours evenly
 * from the first at 0 to the last at 100. Positions are strictly ascending, so
 * there is no hard seam anywhere on the bar.
 */
export function blendStops(
  stops: GradientPreset | readonly string[],
): BlendStop[] {
  const colors = gradientTokens(stops);
  const edges = typeof stops === "string" ? GRADIENT_BREAKS[stops] : undefined;
  return edges ? bandCentreStops(colors, edges) : evenStops(colors);
}

/** The CSS gradient a scale bar paints on its track (tokens only, no hex). */
export function blendGradient(
  stops: GradientPreset | readonly string[],
): string {
  return blendGradientCss(blendStops(stops));
}

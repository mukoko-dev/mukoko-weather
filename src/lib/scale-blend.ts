// Pure helpers that turn a weather scale into a smooth (blended) gradient.
// No React, no DOM, no colour values: every colour is a `var(--wx-*)` token
// reference from weather-scales.ts, so the data colours still follow the
// published conventions and a bar cannot drift from its legend swatch.
//
// Interpolation: explicit stops in the browser's default sRGB gradient space.
// That works in every browser the app supports with no fallback to write (the
// stops sit at the middle of each official band, so the blend between two
// neighbouring official colours is short and stays recognisable); an
// `in oklab` hint would only be honoured from Firefox 127.

export interface BlendStop {
  /** A CSS colour: `var(--wx-aqi-2)`. Never a literal. */
  color: string;
  /** Position along the bar, 0 to 100. */
  pct: number;
}

function round(n: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Stops for colours laid out by the edges of their bands on a bar: each colour
 * sits at the middle of its band (`edgesPct` has one more entry than there are
 * colours). The first and last colour run flat to the ends of the bar.
 */
export function bandCentreStops(
  colors: readonly string[],
  edgesPct: readonly number[],
): BlendStop[] {
  return colors.map((color, i) => ({
    color,
    pct: round(((edgesPct[i] ?? 0) + (edgesPct[i + 1] ?? 100)) / 2),
  }));
}

/** Stops for a plain ramp: first colour at 0, last at 100, the rest evenly. */
export function evenStops(colors: readonly string[]): BlendStop[] {
  if (colors.length === 1) {
    return [
      { color: colors[0], pct: 0 },
      { color: colors[0], pct: 100 },
    ];
  }
  return colors.map((color, i) => ({
    color,
    pct: round((i / (colors.length - 1)) * 100),
  }));
}

/**
 * Stops for colours that sit at values on the scale's own unit (a temperature
 * track): `toPct` maps a value to a position on the bar. Positions may fall
 * outside 0 to 100 (a stop beyond the bar still shapes the blend inside it).
 */
export function valueStops(
  anchors: readonly { token: string; value: number }[],
  toPct: (value: number) => number,
): BlendStop[] {
  return anchors.map((a) => ({
    color: `var(${a.token})`,
    pct: round(toPct(a.value)),
  }));
}

/** `linear-gradient(to right, var(--a) 8.33%, var(--b) 25%, ...)` */
export function blendGradientCss(
  stops: readonly BlendStop[],
  direction = "to right",
): string {
  return `linear-gradient(${direction}, ${stops
    .map((s) => `${s.color} ${s.pct}%`)
    .join(", ")})`;
}

/**
 * A window onto a gradient that spans a whole track (the daily forecast's
 * low-to-high pill, a sub-range of a scale). The window element sits at
 * `left` and is `width` wide (both % of the track); the gradient element
 * inside it is the full track, so it is `innerWidth` % of the window wide and
 * starts `innerLeft` % of the window to the left. A temperature then has the
 * same colour on every row of the week, whatever its pill's extent.
 */
export interface TrackWindow {
  left: number;
  width: number;
  innerLeft: number;
  innerWidth: number;
}

export function trackWindow(
  startPct: number,
  endPct: number,
  minWidthPct = 1,
): TrackWindow {
  const a = clamp(Number.isFinite(startPct) ? startPct : 0, 0, 100);
  const b = clamp(Number.isFinite(endPct) ? endPct : 100, 0, 100);
  const width = clamp(Math.max(Math.abs(b - a), minWidthPct, 1), 1, 100);
  // A window pushed past the right end slides back so it stays on the track.
  const left = Math.min(Math.min(a, b), 100 - width);
  return {
    left: round(left),
    width: round(width),
    innerLeft: round((-left / width) * 100),
    innerWidth: round(10000 / width),
  };
}

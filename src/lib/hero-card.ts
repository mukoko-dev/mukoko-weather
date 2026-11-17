/**
 * Pure helpers for the hero's data card (HeroDataCard): the five-hour strip,
 * the 24-hour temperature curve and the three readings (Feels, Wind, UV).
 *
 * Kept free of React and the store so the hour slicing, the curve geometry and
 * the readings can be unit-tested in Node. Every hour is read in the PLACE's
 * UTC offset (the same rule as the Conditions card and the outlook), never the
 * viewer's zone. A series that is missing, too short or already in the past
 * gives `[]` / `null`, never NaN, so the card can leave a row out instead of
 * drawing an empty or broken one.
 */

import type { CurrentWeather, HourlyWeather } from "./weather";
import { uvLevel } from "./weather";
import { formatWindSpeed } from "./i18n";
import { currentHourIndex } from "./hero";
import {
  currentWallHourMs,
  locationClockLabel,
  resolveOffsetSeconds,
  wallClockMs,
} from "./location-time";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Hours in the strip: "Now" and the next four. */
export const HERO_STRIP_HOURS = 5;
/** Hours the curve spans from the current hour (it draws one more point). */
export const HERO_CURVE_HOURS = 24;
/** A curve needs at least this many readable points (3 hours) to be a curve. */
export const HERO_CURVE_MIN_POINTS = 4;
/** A tick (and its clock label) every this many hours. */
export const HERO_CURVE_TICK_HOURS = 6;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** A temperature as the whole number the hero prints (never "-0"). */
export function roundTemp(value: number): number {
  const r = Math.round(value);
  return r === 0 ? 0 : r;
}

/** "28°", "-3°" — the same form the hero numeral and the hour cards print. */
export function formatDegrees(value: number): string {
  return `${roundTemp(value)}°`;
}

/** A temperature in words for a screen reader: "28", "minus 3". */
function degreesInWords(value: number): string {
  const r = roundTemp(value);
  return r < 0 ? `minus ${-r}` : String(r);
}

/**
 * Index of the place's current hour in an hourly series, or null when the
 * series has no slot for it (empty, the arrays out of step, or already in the
 * past). `currentHourIndex` answers 0 for a stale series "so callers still
 * render something"; here that would label yesterday's hours "Now", so the
 * card leaves its hour rows out instead.
 */
export function heroSeriesStart(
  hourly: HourlyWeather | null | undefined,
  now: Date,
  offsetSeconds?: number | null,
): number | null {
  const times = hourly?.time;
  const temps = hourly?.temperature_2m;
  if (!Array.isArray(times) || !times.length || !Array.isArray(temps)) {
    return null;
  }
  const offset = resolveOffsetSeconds(offsetSeconds, now);
  const index = currentHourIndex(times, now, offset);
  const slot = wallClockMs(times[index], offset);
  const hourStart = currentWallHourMs(offset, now);
  if (slot === null || slot < hourStart || slot >= hourStart + HOUR_MS) {
    return null;
  }
  return index;
}

/** The readable temperatures from `start`, stopping at the first gap. */
function readableRun(
  hourly: HourlyWeather,
  start: number,
  count: number,
  nowTemperature: number | null | undefined,
): Array<{ time: string; temperature: number }> {
  const run: Array<{ time: string; temperature: number }> = [];
  for (let i = 0; i < count; i++) {
    const time = hourly.time[start + i];
    const raw =
      i === 0 && isFiniteNumber(nowTemperature)
        ? nowTemperature
        : hourly.temperature_2m[start + i];
    if (typeof time !== "string" || !isFiniteNumber(raw)) break;
    run.push({ time, temperature: raw });
  }
  return run;
}

// ---------------------------------------------------------------------------
// The five-hour strip
// ---------------------------------------------------------------------------

export interface HeroStripHour {
  /** The slot's ISO time, unique within the strip (a React key). */
  time: string;
  /** "Now", then the place's clock: "15:00". */
  label: string;
  /** Unrounded °C; print it with `formatDegrees`. */
  temperature: number;
}

/**
 * "Now" and the next hours (five by default), read in the place's time.
 * `nowTemperature` (the hero numeral) is the temperature of the first hour, so
 * "Now" and the big number never disagree. Empty when the series is missing,
 * stale or has fewer than two readable hours: the card then has no strip.
 */
export function heroHourStrip(
  hourly: HourlyWeather | null | undefined,
  now: Date,
  offsetSeconds?: number | null,
  nowTemperature?: number | null,
  count: number = HERO_STRIP_HOURS,
): HeroStripHour[] {
  const start = heroSeriesStart(hourly, now, offsetSeconds);
  if (start === null || !hourly) return [];
  const offset = resolveOffsetSeconds(offsetSeconds, now);
  const hours: HeroStripHour[] = [];
  for (const { time, temperature } of readableRun(
    hourly,
    start,
    count,
    nowTemperature,
  )) {
    const label = hours.length === 0 ? "Now" : locationClockLabel(time, offset);
    if (!label) break;
    hours.push({ time, label, temperature });
  }
  return hours.length >= 2 ? hours : [];
}

// ---------------------------------------------------------------------------
// The 24-hour temperature curve
// ---------------------------------------------------------------------------

/**
 * The curve's drawing area in px (1 unit = 1 CSS px: the component sets the
 * viewBox to the element's measured width, so the labels, which are real text
 * at the --text-caption size, are never scaled). `scale` is the root font size
 * over 16px, so the vertical room grows with the visitor's text size.
 */
export const HERO_CURVE_BOX = {
  height: 116,
  top: 30,
  bottom: 32,
  inset: 12,
  dotRadius: 5,
  /** Gap from a dot to the baseline of its label. */
  labelGap: 10,
  /** Baseline of the tick labels, up from the box's foot. */
  tickBaseline: 8,
  /** Width of one label character at the caption size, in px (an estimate). */
  charWidth: 8,
} as const;

/** The curve's width when the element has not been measured yet. */
export const HERO_CURVE_DEFAULT_WIDTH = 320;

export type CurveAnchor = "start" | "middle" | "end";

export interface HeroCurveLabel {
  x: number;
  y: number;
  anchor: CurveAnchor;
  text: string;
}

export interface HeroCurve {
  width: number;
  height: number;
  /** The line, as an SVG path. */
  linePath: string;
  /** The line closed down to the foot of the plot, for the soft fill. */
  areaPath: string;
  /** Y of the foot of the plot. */
  baseY: number;
  /** A vertical line and a clock label every six hours. */
  ticks: Array<{ x: number; y1: number; y2: number; label: HeroCurveLabel }>;
  now: { x: number; y: number; radius: number; label: HeroCurveLabel };
  /**
   * The day's low, when it is lower than now and later than now. Its label is
   * null when there is no room for it beside the now label (the dot stays and
   * the sentence names the low).
   */
  low: {
    x: number;
    y: number;
    radius: number;
    label: HeroCurveLabel | null;
  } | null;
  /** One sentence for a screen reader, like "Temperature over the next …". */
  ariaLabel: string;
}

export interface HeroCurveOptions {
  /** The element's measured width in px. */
  width?: number;
  /** Root font size over 16px (1 at the default text size). */
  scale?: number;
}

/** Anchor a label of `chars` characters so it stays inside [0, width]. */
export function curveLabelAnchor(
  x: number,
  chars: number,
  width: number,
  scale: number,
): CurveAnchor {
  const half = (chars * HERO_CURVE_BOX.charWidth * scale) / 2;
  if (x - half < 0) return "start";
  if (x + half > width) return "end";
  return "middle";
}

/** The x-range a label's text covers (an estimate from its length). */
export function curveLabelSpan(
  label: HeroCurveLabel,
  scale: number,
): [number, number] {
  const w = label.text.length * HERO_CURVE_BOX.charWidth * scale;
  if (label.anchor === "start") return [label.x, label.x + w];
  if (label.anchor === "end") return [label.x - w, label.x];
  return [label.x - w / 2, label.x + w / 2];
}

function fixed(n: number): string {
  return n.toFixed(1);
}

function dayOf(wall: number): number {
  return Math.floor(wall / DAY_MS);
}

/**
 * The next 24 hours of temperature as a drawable curve in the place's time:
 * the points, the now dot, the low marker, the six-hour ticks and the
 * sentence a screen reader gets. Null when fewer than HERO_CURVE_MIN_POINTS
 * hours are readable (missing, stale or too short a series). A series shorter
 * than 24 hours is drawn over the hours it has, and its ticks stop where the
 * data stops. An all-equal series is a flat line in the middle of the plot.
 */
export function heroDayCurve(
  hourly: HourlyWeather | null | undefined,
  now: Date,
  offsetSeconds?: number | null,
  nowTemperature?: number | null,
  options: HeroCurveOptions = {},
): HeroCurve | null {
  const start = heroSeriesStart(hourly, now, offsetSeconds);
  if (start === null || !hourly) return null;
  const offset = resolveOffsetSeconds(offsetSeconds, now);
  const run = readableRun(hourly, start, HERO_CURVE_HOURS + 1, nowTemperature);
  if (run.length < HERO_CURVE_MIN_POINTS) return null;

  const box = HERO_CURVE_BOX;
  const scale =
    isFiniteNumber(options.scale) && options.scale > 0 ? options.scale : 1;
  const width =
    isFiniteNumber(options.width) && options.width > 0
      ? options.width
      : HERO_CURVE_DEFAULT_WIDTH;
  const height = box.height * scale;
  const top = box.top * scale;
  const baseY = height - box.bottom * scale;
  const inset = box.inset * scale;
  const radius = box.dotRadius * scale;
  const steps = run.length - 1;

  const temps = run.map((p) => p.temperature);
  // One degree of room above and below, so the dots and the line never touch
  // the edge and an all-equal series has a range to divide by.
  const lo = Math.min(...temps) - 1;
  const hi = Math.max(...temps) + 1;
  const xAt = (i: number) => inset + ((width - 2 * inset) * i) / steps;
  const yAt = (v: number) => top + ((baseY - top) * (hi - v)) / (hi - lo);

  const clock = (i: number) => locationClockLabel(run[i].time, offset);
  const wall = (i: number) => wallClockMs(run[i].time, offset);
  const nowWall = wall(0);
  const dayWord = (i: number) => {
    const w = wall(i);
    return nowWall !== null && w !== null && dayOf(w) > dayOf(nowWall)
      ? " tomorrow"
      : "";
  };

  const points = temps.map((t, i) => `${fixed(xAt(i))} ${fixed(yAt(t))}`);
  const linePath = `M${points.join("L")}`;
  const areaPath = `${linePath}L${fixed(xAt(steps))} ${fixed(baseY)}L${fixed(
    xAt(0),
  )} ${fixed(baseY)}Z`;

  const label = (
    x: number,
    y: number,
    text: string,
    anchor?: CurveAnchor,
  ): HeroCurveLabel => ({
    x,
    y,
    text,
    anchor: anchor ?? curveLabelAnchor(x, text.length, width, scale),
  });

  // A value label sits above the line everywhere under its text, not only
  // above its own dot: where the line climbs or falls steeply beside the dot
  // the label would otherwise be crossed by it. Returns the label's baseline
  // for a label of `chars` characters from `x` (anchored `anchor`), `gap`
  // above the highest point of the line within its span (one step wider on
  // each side, since the line is straight between points).
  const baselineAbove = (
    x: number,
    anchor: CurveAnchor,
    chars: number,
    dotY: number,
    gap: number,
  ) => {
    const w = chars * box.charWidth * scale;
    const from = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
    const step = (width - 2 * inset) / steps;
    let highest = dotY;
    for (let i = 0; i < temps.length; i++) {
      const px = xAt(i);
      if (px >= from - step && px <= from + w + step) {
        highest = Math.min(highest, yAt(temps[i]));
      }
    }
    return highest - gap;
  };

  const nowX = xAt(0);
  const nowY = yAt(temps[0]);
  const nowText = `${formatDegrees(temps[0])} now`;
  const nowLabelX = nowX + radius + 5 * scale;
  const nowDot = {
    x: nowX,
    y: nowY,
    radius,
    // Right of the dot, above the line, from the dot's own left inset.
    label: label(
      nowLabelX,
      baselineAbove(
        nowLabelX,
        "start",
        nowText.length,
        nowY,
        box.labelGap * scale,
      ),
      nowText,
      "start",
    ),
  };

  // The low: the first coolest hour, shown only when it is cooler than now
  // (to the printed degree) and not now itself.
  let lowIndex = 0;
  for (let i = 1; i < temps.length; i++) {
    if (temps[i] < temps[lowIndex]) lowIndex = i;
  }
  const lowDot =
    lowIndex > 0 && roundTemp(temps[lowIndex]) < roundTemp(temps[0])
      ? (() => {
          const x = xAt(lowIndex);
          const y = yAt(temps[lowIndex]);
          const text = `${formatDegrees(temps[lowIndex])} at ${clock(lowIndex)}`;
          const gap = radius + box.labelGap * scale;
          const place = (lx: number, anchor: CurveAnchor) =>
            label(
              lx,
              baselineAbove(lx, anchor, text.length, y, gap),
              text,
              anchor,
            );
          let lowLabel: HeroCurveLabel | null = place(
            x,
            curveLabelAnchor(x, text.length, width, scale),
          );
          // Two labels never sit on each other: when the low is soon after
          // now, its label moves to the right of the now label, or is left out
          // when it would not fit there (the dot stays, the sentence names it).
          const line = 21 * scale;
          const apart = (a: HeroCurveLabel, b: HeroCurveLabel) => {
            const [a0, a1] = curveLabelSpan(a, scale);
            const [b0, b1] = curveLabelSpan(b, scale);
            return a1 + 4 * scale <= b0 || b1 + 4 * scale <= a0;
          };
          const clear = (l: HeroCurveLabel) =>
            Math.abs(l.y - nowDot.label.y) >= line || apart(nowDot.label, l);
          if (!clear(lowLabel)) {
            const [, nowEnd] = curveLabelSpan(nowDot.label, scale);
            lowLabel = place(nowEnd + 8 * scale, "start");
            const [, lowEnd] = curveLabelSpan(lowLabel, scale);
            if (lowEnd > width || !clear(lowLabel)) lowLabel = null;
          }
          return { x, y, radius, label: lowLabel };
        })()
      : null;

  const ticks: HeroCurve["ticks"] = [];
  for (let k = 0; k <= steps; k += HERO_CURVE_TICK_HOURS) {
    const text = clock(k);
    if (!text) continue;
    const x = xAt(k);
    ticks.push({
      x,
      y1: top,
      y2: baseY,
      label: label(x, height - box.tickBaseline * scale, text),
    });
  }

  // "Temperature over the next 24 hours: 28 degrees now at 14:00, falling to
  // a low of 13 degrees at 05:00 tomorrow, then rising to 28 degrees by 14:00
  // tomorrow."
  const last = temps.length - 1;
  const trend = (from: number, to: number) =>
    roundTemp(to) > roundTemp(from)
      ? "rising to"
      : roundTemp(to) < roundTemp(from)
        ? "falling to"
        : "holding at";
  let sentence = `Temperature over the next ${steps} hours: ${degreesInWords(
    temps[0],
  )} degrees now at ${clock(0)}`;
  if (lowDot && lowIndex < last) {
    sentence += `, falling to a low of ${degreesInWords(
      temps[lowIndex],
    )} degrees at ${clock(lowIndex)}${dayWord(lowIndex)}, then ${trend(
      temps[lowIndex],
      temps[last],
    )} ${degreesInWords(temps[last])} degrees by ${clock(last)}${dayWord(last)}`;
  } else if (lowDot) {
    sentence += `, falling to a low of ${degreesInWords(
      temps[lowIndex],
    )} degrees at ${clock(lowIndex)}${dayWord(lowIndex)}`;
  } else {
    sentence += `, ${trend(temps[0], temps[last])} ${degreesInWords(
      temps[last],
    )} degrees by ${clock(last)}${dayWord(last)}`;
  }

  return {
    width,
    height,
    linePath,
    areaPath,
    baseY,
    ticks,
    now: nowDot,
    low: lowDot,
    ariaLabel: `${sentence}.`,
  };
}

// ---------------------------------------------------------------------------
// The three readings
// ---------------------------------------------------------------------------

export type HeroReadingKey = "feels" | "wind" | "uv";

export interface HeroReading {
  key: HeroReadingKey;
  label: string;
  /** The figure: "27°", "12", "9". */
  value: string;
  /** What follows the figure, smaller: "km/h", "Very High". */
  unit: string | null;
}

/**
 * Split a formatted quantity ("12 km/h") at its first space into the figure
 * and the unit, so the unit can be set smaller. No space: all of it is the
 * figure.
 */
function splitUnit(text: string): [string, string | null] {
  const at = text.search(/\s/);
  if (at <= 0) return [text, null];
  return [text.slice(0, at), text.slice(at + 1).trim() || null];
}

/**
 * Feels, Wind and UV for the card's readings row. A reading with no finite
 * value is left out (never "NaN"), so a payload missing one still shows the
 * others, and one missing all of them shows no row.
 */
export function heroReadings(
  current: Partial<
    Pick<CurrentWeather, "apparent_temperature" | "wind_speed_10m" | "uv_index">
  >,
): HeroReading[] {
  const readings: HeroReading[] = [];
  if (isFiniteNumber(current.apparent_temperature)) {
    readings.push({
      key: "feels",
      label: "Feels",
      value: formatDegrees(current.apparent_temperature),
      unit: null,
    });
  }
  if (isFiniteNumber(current.wind_speed_10m)) {
    const [value, unit] = splitUnit(formatWindSpeed(current.wind_speed_10m));
    readings.push({ key: "wind", label: "Wind", value, unit });
  }
  if (isFiniteNumber(current.uv_index)) {
    readings.push({
      key: "uv",
      label: "UV",
      value: String(Math.max(0, Math.round(current.uv_index))),
      unit: uvLevel(current.uv_index).label,
    });
  }
  return readings;
}

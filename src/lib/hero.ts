/**
 * Pure helpers for the location hero (CurrentConditions).
 *
 * Kept free of React and the store so the eyebrow selection, the high/low
 * formatting, the sky-plate family and the activity clause can be unit-tested
 * in Node.
 */

import type { HourlyWeather } from "./weather";
import { hourlySummary } from "./hourly-summary";
import {
  currentHourIndex as locationCurrentHourIndex,
  locationHourLabel,
  resolveOffsetSeconds,
} from "./location-time";

/** Eyebrow badges shown above the place name, in display order. */
export type HeroBadge = "current" | "home";

/**
 * Which eyebrow badges to show above the place name.
 *
 * - current location only  -> ["current"]   (➤ MY LOCATION)
 * - home only              -> ["home"]      (⌂ HOME)
 * - both                   -> ["current", "home"]
 * - neither                -> []            (no eyebrow)
 */
export function heroEyebrowBadges(
  isCurrentLocation: boolean,
  isHome: boolean,
): HeroBadge[] {
  const badges: HeroBadge[] = [];
  if (isCurrentLocation) badges.push("current");
  if (isHome) badges.push("home");
  return badges;
}

/** Uppercase-friendly label for an eyebrow badge (CSS applies the caps). */
export function heroBadgeLabel(badge: HeroBadge): string {
  return badge === "current" ? "My Location" : "Home";
}

/**
 * True when the place being shown is the visitor's saved home place.
 * `homeLocation` is a location slug (or null when no home is set).
 */
export function isHomeLocation(
  slug: string | undefined,
  homeLocation: string | null | undefined,
): boolean {
  return Boolean(slug) && Boolean(homeLocation) && slug === homeLocation;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Formats today's high/low as the hero line, e.g. "H:34°  L:25°".
 * Returns null when either value is missing or not a finite number, so the
 * hero never renders "H:NaN°" (the daily arrays can be empty).
 */
export function formatHighLow(
  high: number | null | undefined,
  low: number | null | undefined,
): string | null {
  if (!isFiniteNumber(high) || !isFiniteNumber(low)) return null;
  return `H:${Math.round(high)}°  L:${Math.round(low)}°`;
}

// ---------------------------------------------------------------------------
// Sky plate — the solid mineral surface behind the hero
// ---------------------------------------------------------------------------

/**
 * Plate family: the condition family × day/night that picks the mineral tint.
 * Hue follows the condition family (and time of day), never a gradient or an
 * animated sky — the plate is a flat, solid surface.
 */
export type PlateFamily =
  | "clear-day"
  | "clear-night"
  | "cloudy-day"
  | "cloudy-night"
  | "fog"
  | "rain"
  | "storm"
  | "snow";

/** WMO weather code → plate family. Unknown codes read as cloudy. */
export function plateFamily(weatherCode: number, isDay: boolean): PlateFamily {
  if (weatherCode >= 95) return "storm";
  if (
    (weatherCode >= 71 && weatherCode <= 77) ||
    weatherCode === 85 ||
    weatherCode === 86
  )
    return "snow";
  if (
    (weatherCode >= 51 && weatherCode <= 67) ||
    (weatherCode >= 80 && weatherCode <= 82)
  )
    return "rain";
  if (weatherCode === 45 || weatherCode === 48) return "fog";
  if (weatherCode === 0 || weatherCode === 1)
    return isDay ? "clear-day" : "clear-night";
  return isDay ? "cloudy-day" : "cloudy-night";
}

/**
 * Fauna modifier class per plate family. Literal class names so Tailwind's
 * JIT keeps them; each one points `--kori-bg/fg` at a `--plate-*` token.
 */
export const PLATE_CLASS: Record<PlateFamily, string> = {
  "clear-day": "kori-clear-day",
  "clear-night": "kori-clear-night",
  "cloudy-day": "kori-cloudy-day",
  "cloudy-night": "kori-cloudy-night",
  fog: "kori-fog",
  rain: "kori-rain",
  storm: "kori-storm",
  snow: "kori-snow",
};

/** Activity category → solid mineral dot (static literals for Tailwind JIT). */
export const ACTIVITY_DOT_CLASS: Record<string, string> = {
  farming: "bg-mineral-malachite",
  mining: "bg-mineral-terracotta",
  travel: "bg-mineral-cobalt",
  tourism: "bg-mineral-tanzanite",
  sports: "bg-mineral-gold",
  casual: "bg-mineral-copper",
};

/** Dot class for a category; falls back to copper for unknown categories. */
export function activityDotClass(category: string): string {
  return ACTIVITY_DOT_CLASS[category] ?? "bg-mineral-copper";
}

/**
 * Index of the LOCATION's current hour in an hourly series (same rule as
 * feasibility). `offsetSeconds` is the payload's `utc_offset_seconds`; the
 * viewer's clock is only a fallback for payloads that predate it.
 */
export function currentHourIndex(
  times: string[],
  now: Date,
  offsetSeconds?: number | null,
): number {
  return locationCurrentHourIndex(
    times,
    resolveOffsetSeconds(offsetSeconds, now),
    now,
  );
}

/**
 * The hero's one plain sentence, built by the deterministic hourly outlook
 * (no AI call). Returns null when the series is too short to say anything.
 */
export function heroOutlook(
  hourly: HourlyWeather | undefined,
  now: Date,
  offsetSeconds?: number | null,
): string | null {
  if (!hourly?.time?.length) return null;
  const offset = resolveOffsetSeconds(offsetSeconds, now);
  return hourlySummary(
    hourly,
    currentHourIndex(hourly.time, now, offset),
    offset,
  );
}

/** One point of a per-activity 24h suitability series. */
export interface ActivityLevelPoint {
  time: string;
  level: "excellent" | "good" | "fair" | "poor";
}

function hourClock(iso: string, offsetSeconds: number): string | null {
  return locationHourLabel(iso, offsetSeconds) || null;
}

/**
 * The "for your activities" clause for one activity, e.g.
 *   "good until 15:00"            (the rating changes at 15:00)
 *   "good for the next 24 hours"  (no change in the series)
 * Returns null when there is no series to read.
 */
export function heroActivityClause(
  points: ActivityLevelPoint[],
  offsetSeconds?: number | null,
): string | null {
  if (!points.length) return null;
  const now = points[0].level;
  const change = points.findIndex((p, i) => i > 0 && p.level !== now);
  if (change > 0) {
    const clock = hourClock(
      points[change].time,
      resolveOffsetSeconds(offsetSeconds),
    );
    if (clock) return `${now} until ${clock}`;
  }
  return `${now} for the next ${points.length} hours`;
}

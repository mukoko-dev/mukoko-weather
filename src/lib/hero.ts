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
 * hero never renders "H NaN°" (the daily arrays can be empty).
 */
export function formatHighLow(
  high: number | null | undefined,
  low: number | null | undefined,
): string | null {
  if (!isFiniteNumber(high) || !isFiniteNumber(low)) return null;
  return `H:${Math.round(high)}°  L:${Math.round(low)}°`;
}

/**
 * The hero's H/L line as separate parts, ["H:34°", "L:25°"] — the line wraps
 * between them at large text sizes instead of overflowing. Null when either
 * value is missing or not finite.
 */
export function formatHighLowParts(
  high: number | null | undefined,
  low: number | null | undefined,
): [string, string] | null {
  if (!isFiniteNumber(high) || !isFiniteNumber(low)) return null;
  return [`H:${Math.round(high)}°`, `L:${Math.round(low)}°`];
}

/**
 * "17:03 LOCAL" — the place's own clock for the hero eyebrow when no MY
 * LOCATION / HOME badge applies. Read in the PLACE's UTC offset, never the
 * viewer's zone; null until the caller has a client clock.
 */
export function heroLocalTime(
  now: Date | null,
  offsetSeconds?: number | null,
): string | null {
  if (!now || !Number.isFinite(now.getTime())) return null;
  const local = new Date(
    now.getTime() + resolveOffsetSeconds(offsetSeconds, now) * 1000,
  );
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())} LOCAL`;
}

// ---------------------------------------------------------------------------
// Open sky — the gradient band behind the hero
// ---------------------------------------------------------------------------

/**
 * Sky family: the condition family × day/night that picks the gradient.
 * The sky band is a static CSS gradient (no animation); see `.kestrel` in
 * globals.css.
 */
export type SkyFamily =
  | "clear-day"
  | "clear-night"
  | "cloudy-day"
  | "cloudy-night"
  | "fog"
  | "rain"
  | "storm"
  | "snow";

/** WMO weather code → sky family. Unknown codes read as cloudy. */
export function skyFamily(weatherCode: number, isDay: boolean): SkyFamily {
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
 * Fauna modifier class per sky family. Literal class names so Tailwind's
 * JIT keeps them; each one points `--kestrel-top/bottom` at a `--sky-*` pair.
 */
export const SKY_CLASS: Record<SkyFamily, string> = {
  "clear-day": "kestrel-clear-day",
  "clear-night": "kestrel-clear-night",
  "cloudy-day": "kestrel-cloudy-day",
  "cloudy-night": "kestrel-cloudy-night",
  fog: "kestrel-fog",
  rain: "kestrel-rain",
  storm: "kestrel-storm",
  snow: "kestrel-snow",
};

/**
 * The faint static texture a sky carries: stars on the night skies, diagonal
 * streaks on rain and storms, nothing on the rest. Never animated.
 */
export type SkyTexture = "stars" | "streaks";
export function skyTexture(family: SkyFamily): SkyTexture | null {
  if (family === "clear-night" || family === "cloudy-night") return "stars";
  if (family === "rain" || family === "storm") return "streaks";
  return null;
}

/** Solid sky kept below the last thing that sits on it, in rem. */
export const SKY_CLEARANCE_REM = 1.5;
/** The fade at the sky's foot, in rem (mirrors `--sky-fade` in globals.css). */
export const SKY_FADE_REM = 6;
/**
 * The sky is never shorter than this, in rem (mirrors `--sky-reach` in
 * globals.css). The hero + Conditions card ends 44 to 51 rem down the page
 * (measured at 100% and 200% text; it scales with the root font), so with the
 * fade and clearance (7.5 rem) this floor keeps the card out of the fade in a
 * short landscape viewport BEFORE the script has measured it (server HTML,
 * slow hydration, no JavaScript).
 */
export const SKY_MIN_REM = 60;

/**
 * The sky's height (a CSS length) so it always extends past the content that
 * sits on it: the larger of one screen + 8rem and the bottom of that content
 * (document px) plus clearance and the fade. The sky therefore never starts
 * fading under the hero or the Conditions card, however large the text size
 * or short the viewport. Null when there is nothing to measure (keep the CSS
 * default). `rootPx` is the root font size, so the margin scales with text
 * zoom.
 */
export function skyReachCss(
  contentBottomPx: number | null | undefined,
  rootPx: number,
): string | null {
  if (
    typeof contentBottomPx !== "number" ||
    !Number.isFinite(contentBottomPx) ||
    !Number.isFinite(rootPx) ||
    rootPx <= 0
  ) {
    return null;
  }
  const px = Math.ceil(
    Math.max(0, contentBottomPx) + (SKY_CLEARANCE_REM + SKY_FADE_REM) * rootPx,
  );
  return `max(100svh + 8rem, ${SKY_MIN_REM}rem, ${px}px)`;
}

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

/**
 * Activity feasibility over time — evaluates an activity's suitability rule
 * against each of the next 24 hours of forecast data, producing a 0–100
 * score series for the per-activity feasibility line chart.
 *
 * Reuses the same database-driven rules engine (`evaluateRule`) the activity
 * cards use for their current-conditions badge, so the trend line and the
 * badge can never disagree about what "good" means for an activity.
 */

import type { Activity } from "./activities";
import {
  wmoToInsightHazards,
  type HourlyWeather,
  type WeatherInsights,
} from "./weather";
import type { SuitabilityRuleDoc } from "./db";
import { evaluateRule, type SuitabilityRating } from "./suitability";
import {
  currentHourIndex,
  locationHourLabel,
  resolveOffsetSeconds,
} from "./location-time";

export type SuitabilityLevel = SuitabilityRating["level"];

/** Level → chartable score. Poor is deliberately non-zero so the line stays visible. */
export const LEVEL_SCORES: Record<SuitabilityLevel, number> = {
  excellent: 100,
  good: 75,
  fair: 50,
  poor: 25,
};

/** Score → human label for chart ticks and tooltips. */
export function scoreLabel(score: number): string {
  if (score >= 100) return "Excellent";
  if (score >= 75) return "Good";
  if (score >= 50) return "Fair";
  return "Poor";
}

/**
 * Dew point (°C) from temperature and relative humidity via the
 * Magnus-Tetens approximation — accurate to ~0.35°C in the -45..60°C range.
 */
export function dewPointFromTempHumidity(
  tempC: number,
  rhPercent: number,
): number {
  const rh = Math.min(100, Math.max(1, rhPercent));
  const a = 17.62;
  const b = 243.12;
  const gamma = Math.log(rh / 100) + (a * tempC) / (b + tempC);
  return (b * gamma) / (a - gamma);
}

/**
 * Build a per-hour WeatherInsights object from hourly forecast arrays.
 *
 * Uses the same WMO-code → thunderstorm/precipitationType mapping as
 * `synthesizeOpenMeteoInsights` (via `wmoToInsightHazards`) but samples a single
 * hour index instead of current conditions. Only fields that can honestly be
 * derived from hourly data are set — rule conditions on absent fields simply
 * don't match, which is how the rules engine already treats missing data.
 */
export function hourInsights(
  hourly: HourlyWeather,
  i: number,
): WeatherInsights {
  const { thunderstormProbability, precipitationType } = wmoToInsightHazards(
    hourly.weather_code?.[i] ?? 0,
  );

  const temp = hourly.temperature_2m?.[i];
  const rh = hourly.relative_humidity_2m?.[i];
  // Open-Meteo visibility is metres; the insights field (and the 1/2/3/5 km
  // rule thresholds) are km — same conversion as synthesizeOpenMeteoInsights.
  const visM = hourly.visibility?.[i];

  return {
    windSpeed: hourly.wind_speed_10m?.[i],
    windGust: hourly.wind_gusts_10m?.[i],
    visibility: visM != null ? visM / 1000 : undefined,
    uvHealthConcern: hourly.uv_index?.[i],
    thunderstormProbability,
    precipitationType,
    dewPoint:
      temp != null && rh != null
        ? dewPointFromTempHumidity(temp, rh)
        : undefined,
  };
}

/** Resolve the rule for an activity: activity-specific override wins over category. */
export function resolveRule(
  activity: Pick<Activity, "id" | "category">,
  dbRules: Map<string, SuitabilityRuleDoc>,
): SuitabilityRuleDoc | undefined {
  return (
    dbRules.get(`activity:${activity.id}`) ??
    dbRules.get(`category:${activity.category}`)
  );
}

export interface FeasibilityPoint {
  /** ISO time of the hour */
  time: string;
  /** "HH:00" at the LOCATION (its own time zone, not the viewer's) */
  label?: string;
  /** 0–100 feasibility score */
  score: number;
  /** The rule level that produced the score */
  level: SuitabilityLevel;
}

/**
 * Score the next `hours` hours (default 24) of forecast against the
 * activity's suitability rule. Starts at the current hour (same slicing
 * convention as `prepareAtmosphericData`). Returns [] when no rule exists
 * or hourly data is missing — callers hide the chart in that case.
 */
export function feasibilitySeries(
  activity: Pick<Activity, "id" | "category">,
  hourly: HourlyWeather | undefined,
  dbRules: Map<string, SuitabilityRuleDoc>,
  hours = 24,
  offsetSeconds?: number | null,
  now: Date = new Date(),
): FeasibilityPoint[] {
  const rule = resolveRule(activity, dbRules);
  if (!rule || !hourly?.time?.length) return [];

  // Start at the LOCATION's current hour (payload `utc_offset_seconds`) —
  // never the viewer's clock or the server's UTC.
  const offset = resolveOffsetSeconds(offsetSeconds, now);
  const start = currentHourIndex(hourly.time, offset, now);

  const points: FeasibilityPoint[] = [];
  for (let i = 0; i < hours && start + i < hourly.time.length; i++) {
    const idx = start + i;
    const rating = evaluateRule(rule, hourInsights(hourly, idx));
    points.push({
      time: hourly.time[idx],
      label: locationHourLabel(hourly.time[idx], offset),
      score: LEVEL_SCORES[rating.level] ?? LEVEL_SCORES.fair,
      level: rating.level,
    });
  }
  return points;
}

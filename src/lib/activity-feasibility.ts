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
import type { HourlyWeather, WeatherInsights } from "./weather";
import type { SuitabilityRuleDoc } from "./db";
import { evaluateRule, type SuitabilityRating } from "./suitability";

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
export function dewPointFromTempHumidity(tempC: number, rhPercent: number): number {
  const rh = Math.min(100, Math.max(1, rhPercent));
  const a = 17.62;
  const b = 243.12;
  const gamma = Math.log(rh / 100) + (a * tempC) / (b + tempC);
  return (b * gamma) / (a - gamma);
}

/**
 * Build a per-hour WeatherInsights object from hourly forecast arrays.
 *
 * Mirrors `synthesizeOpenMeteoInsights`' conventions (same WMO-code →
 * thunderstorm/precipitationType mappings, same units) but samples a single
 * hour index instead of current conditions. Only fields that can honestly be
 * derived from hourly data are set — rule conditions on absent fields simply
 * don't match, which is how the rules engine already treats missing data.
 */
export function hourInsights(hourly: HourlyWeather, i: number): WeatherInsights {
  const weatherCode = hourly.weather_code?.[i] ?? 0;

  // WMO 95–99 = thunderstorm activity (same graduation as synthesizeOpenMeteoInsights)
  let thunderstormProbability = 0;
  if (weatherCode >= 99) thunderstormProbability = 95;
  else if (weatherCode >= 96) thunderstormProbability = 85;
  else if (weatherCode >= 95) thunderstormProbability = 70;

  // WMO code → precipitationType: 0=none, 1=rain, 2=snow, 3=freezing rain
  let precipitationType = 0;
  if ((weatherCode >= 71 && weatherCode <= 77) || (weatherCode >= 85 && weatherCode <= 86)) precipitationType = 2;
  else if (weatherCode === 66 || weatherCode === 67 || weatherCode === 56 || weatherCode === 57) precipitationType = 3;
  else if (weatherCode >= 51) precipitationType = 1;

  const temp = hourly.temperature_2m?.[i];
  const rh = hourly.relative_humidity_2m?.[i];

  return {
    windSpeed: hourly.wind_speed_10m?.[i],
    windGust: hourly.wind_gusts_10m?.[i],
    visibility: hourly.visibility?.[i],
    uvHealthConcern: hourly.uv_index?.[i],
    thunderstormProbability,
    precipitationType,
    dewPoint:
      temp != null && rh != null ? dewPointFromTempHumidity(temp, rh) : undefined,
  };
}

/** Resolve the rule for an activity: activity-specific override wins over category. */
export function resolveRule(
  activity: Pick<Activity, "id" | "category">,
  dbRules: Map<string, SuitabilityRuleDoc>,
): SuitabilityRuleDoc | undefined {
  return dbRules.get(`activity:${activity.id}`) ?? dbRules.get(`category:${activity.category}`);
}

export interface FeasibilityPoint {
  /** ISO time of the hour */
  time: string;
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
): FeasibilityPoint[] {
  const rule = resolveRule(activity, dbRules);
  if (!rule || !hourly?.time?.length) return [];

  const now = new Date();
  const currentHour = now.getHours();
  const startIndex = hourly.time.findIndex(
    (t) =>
      new Date(t).getHours() >= currentHour &&
      new Date(t).getDate() === now.getDate(),
  );
  const start = startIndex >= 0 ? startIndex : 0;

  const points: FeasibilityPoint[] = [];
  for (let i = 0; i < hours && start + i < hourly.time.length; i++) {
    const idx = start + i;
    const rating = evaluateRule(rule, hourInsights(hourly, idx));
    points.push({
      time: hourly.time[idx],
      score: LEVEL_SCORES[rating.level] ?? LEVEL_SCORES.fair,
      level: rating.level,
    });
  }
  return points;
}

/**
 * Deterministic one-sentence summary for the hourly forecast strip — the
 * Apple Weather pattern ("Hazy conditions expected around 19:00. Wind gusts
 * are up to 26 km/h."). Pure function over the hourly arrays: no AI call,
 * no network, renders instantly with the card and never hallucinates.
 */

import type { HourlyWeather } from "./weather";

/** Hours of forecast the summary looks ahead. */
export const SUMMARY_LOOKAHEAD_HOURS = 12;

/** Gust threshold (km/h) above which the wind clause is added. */
export const GUST_MENTION_KMH = 25;

/**
 * Coarse condition groups — transitions between groups are what the sentence
 * reports. Finer changes (e.g. slight → moderate rain) stay silent.
 */
type ConditionGroup =
  | "clear"
  | "partly cloudy"
  | "cloudy"
  | "foggy"
  | "drizzly"
  | "rainy"
  | "snowy"
  | "stormy";

export function conditionGroup(code: number): ConditionGroup {
  if (code >= 95) return "stormy";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snowy";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rainy";
  if (code >= 51 && code <= 57) return "drizzly";
  if (code === 45 || code === 48) return "foggy";
  if (code === 3) return "cloudy";
  if (code === 1 || code === 2) return "partly cloudy";
  return "clear";
}

/** Phrase used when a group ARRIVES ("X expected around 14:00"). */
const ARRIVAL_PHRASE: Record<ConditionGroup, string> = {
  clear: "Clear conditions",
  "partly cloudy": "Partly cloudy conditions",
  cloudy: "Cloudy conditions",
  foggy: "Foggy conditions",
  drizzly: "Drizzle",
  rainy: "Rain",
  snowy: "Snow",
  stormy: "Thunderstorms",
};

/** Phrase used when a group PERSISTS ("X will continue…"). */
const CONTINUE_PHRASE: Record<ConditionGroup, string> = {
  clear: "Clear conditions",
  "partly cloudy": "Partly cloudy conditions",
  cloudy: "Cloudy conditions",
  foggy: "Foggy conditions",
  drizzly: "Drizzle",
  rainy: "Rain",
  snowy: "Snow",
  stormy: "Thunderstorms",
};

function hourLabel(iso: string): string {
  return `${String(new Date(iso).getHours()).padStart(2, "0")}:00`;
}

/**
 * Build the summary from the hourly arrays, starting at `start` (the same
 * current-hour index the hourly strip itself uses — callers pass it so the
 * sentence and the strip can't disagree about what "now" is).
 *
 * Returns null when there isn't enough data to say anything meaningful.
 */
export function hourlySummary(hourly: HourlyWeather, start: number): string | null {
  const codes = hourly.weather_code;
  const times = hourly.time;
  if (!codes?.length || !times?.length || start < 0 || start >= codes.length) return null;

  const end = Math.min(start + SUMMARY_LOOKAHEAD_HOURS, codes.length);
  if (end - start < 2) return null;

  const nowGroup = conditionGroup(codes[start]);

  // First hour whose coarse condition group differs from now
  let changeIdx = -1;
  for (let i = start + 1; i < end; i++) {
    if (conditionGroup(codes[i]) !== nowGroup) {
      changeIdx = i;
      break;
    }
  }

  let sentence: string;
  if (changeIdx > 0) {
    sentence = `${ARRIVAL_PHRASE[conditionGroup(codes[changeIdx])]} expected around ${hourLabel(times[changeIdx])}.`;
  } else {
    sentence = `${CONTINUE_PHRASE[nowGroup]} will continue for the next ${end - start} hours.`;
  }

  // Wind clause — peak gusts over the same window
  const gusts = hourly.wind_gusts_10m ?? [];
  let maxGust = 0;
  for (let i = start; i < end; i++) {
    if ((gusts[i] ?? 0) > maxGust) maxGust = gusts[i];
  }
  if (maxGust >= GUST_MENTION_KMH) {
    sentence += ` Wind gusts are up to ${Math.round(maxGust)} km/h.`;
  }

  return sentence;
}

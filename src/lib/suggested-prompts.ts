/**
 * Generates contextual AI follow-up prompts based on current weather conditions,
 * location, and user activities. Used by AISummaryChat and other inline AI features.
 *
 * Prompt rules are fetched from MongoDB via /api/py/ai/suggested-rules.
 * A client-side cache (5-min TTL) avoids redundant fetches. If the API is
 * unavailable, a minimal hardcoded fallback ensures at least one prompt.
 */

import type { WeatherData } from "./weather";
import type { ZimbabweLocation } from "./locations";

export interface SuggestedPrompt {
  label: string;
  query: string;
}

/** Shape of a suggested-prompt rule from the database */
export interface SuggestedPromptRule {
  ruleId: string;
  label: string;
  queryTemplate: string;
  category: "weather" | "activity" | "generic";
  condition: {
    field: string;
    operator: "gt" | "gte" | "lt" | "lte" | "eq" | "in";
    value: number | number[] | string[];
    source?: "weather" | "activities" | "hourly";
  } | null;
  active: boolean;
  order: number;
}

// ---------------------------------------------------------------------------
// Client-side rule cache (5-min TTL)
// ---------------------------------------------------------------------------

let _rulesCache: SuggestedPromptRule[] | null = null;
let _rulesCacheAt = 0;
const RULES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch suggested-prompt rules from the database.
 * Returns cached rules if available and fresh.
 */
export async function fetchSuggestedRules(): Promise<SuggestedPromptRule[]> {
  const now = Date.now();
  if (_rulesCache && (now - _rulesCacheAt) < RULES_CACHE_TTL) {
    return _rulesCache;
  }

  try {
    const res = await fetch("/api/py/ai/suggested-rules");
    if (res.ok) {
      const data = await res.json();
      const rules: SuggestedPromptRule[] = data.rules ?? [];
      _rulesCache = rules;
      _rulesCacheAt = now;
      return rules;
    }
  } catch {
    // API unavailable — fall through to cache or empty
  }

  return _rulesCache ?? [];
}

/** Reset the rules cache (for testing) */
export function resetRulesCache(): void {
  _rulesCache = null;
  _rulesCacheAt = 0;
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate a single rule condition against weather data and activities.
 * Returns true if the condition is met (or if condition is null for generic rules).
 */
function evaluateCondition(
  condition: SuggestedPromptRule["condition"],
  weather: WeatherData,
  activities: string[],
): boolean {
  if (!condition) return true; // Generic rules always match

  const { field, operator, value, source } = condition;

  // Activity-based rules: check if any of the user's activities match
  if (source === "activities") {
    if (operator === "in" && Array.isArray(value)) {
      return activities.some((a) => (value as string[]).includes(a));
    }
    return false;
  }

  // Hourly data source
  if (source === "hourly") {
    const hourlyData = weather.hourly as unknown as Record<string, unknown[]>;
    const hourlyVal = hourlyData?.[field]?.[0];
    if (hourlyVal == null) return false;
    return compareValues(Number(hourlyVal), operator, value as number);
  }

  // Weather (current) data source — default
  const currentData = weather.current as unknown as Record<string, unknown>;
  const weatherVal = currentData?.[field];
  if (weatherVal == null) return false;
  return compareValues(Number(weatherVal), operator, value as number);
}

function compareValues(
  actual: number,
  operator: string,
  threshold: number,
): boolean {
  switch (operator) {
    case "gt": return actual > threshold;
    case "gte": return actual >= threshold;
    case "lt": return actual < threshold;
    case "lte": return actual <= threshold;
    case "eq": return actual === threshold;
    default: return false;
  }
}

/**
 * Interpolate template variables in a query string.
 * Supports: {location}, {temperature}, {uvIndex}, {humidity}, {windSpeed}
 */
function interpolateQuery(
  template: string,
  weather: WeatherData,
  location: Pick<ZimbabweLocation, "name" | "slug">,
): string {
  const c = weather.current;
  return template
    .replace(/\{location\}/g, location.name)
    .replace(/\{temperature\}/g, String(Math.round(c.temperature_2m)))
    .replace(/\{uvIndex\}/g, String(Math.round(c.uv_index)))
    .replace(/\{humidity\}/g, String(c.relative_humidity_2m))
    .replace(/\{windSpeed\}/g, String(Math.round(c.wind_speed_10m)));
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

/**
 * Generate up to 3 contextual suggested prompts based on weather data,
 * location, and user activities.
 *
 * Uses database-driven rules when available, with inline evaluation.
 * Rules are sorted: weather conditions first, then activity, then generic.
 */
export function generateSuggestedPrompts(
  weather: WeatherData,
  location: Pick<ZimbabweLocation, "name" | "slug">,
  activities: string[],
  rules?: SuggestedPromptRule[],
): SuggestedPrompt[] {
  // If no rules provided (sync call), use cached or empty
  const activeRules = rules ?? _rulesCache ?? [];

  // If no database rules available, use minimal fallback
  if (activeRules.length === 0) {
    return _fallbackPrompts(weather, location, activities);
  }

  const prompts: SuggestedPrompt[] = [];

  // Rules are pre-sorted by category priority and order from the database
  // Category sort: weather (evaluated first) → activity → generic
  const sorted = [...activeRules].sort((a, b) => {
    const categoryOrder = { weather: 0, activity: 1, generic: 2 };
    const catDiff = (categoryOrder[a.category] ?? 2) - (categoryOrder[b.category] ?? 2);
    if (catDiff !== 0) return catDiff;
    return a.order - b.order;
  });

  for (const rule of sorted) {
    if (!rule.active) continue;
    if (evaluateCondition(rule.condition, weather, activities)) {
      prompts.push({
        label: rule.label,
        query: interpolateQuery(rule.queryTemplate, weather, location),
      });
    }
  }

  // Deduplicate by label (first wins) and cap at 3
  const seen = new Set<string>();
  const unique: SuggestedPrompt[] = [];
  for (const p of prompts) {
    if (!seen.has(p.label)) {
      seen.add(p.label);
      unique.push(p);
    }
    if (unique.length >= 3) break;
  }

  return unique;
}

/**
 * Async version that fetches rules from the database first.
 * Use this in components that can await.
 */
export async function generateSuggestedPromptsAsync(
  weather: WeatherData,
  location: Pick<ZimbabweLocation, "name" | "slug">,
  activities: string[],
): Promise<SuggestedPrompt[]> {
  const rules = await fetchSuggestedRules();
  return generateSuggestedPrompts(weather, location, activities, rules);
}

// ---------------------------------------------------------------------------
// Minimal fallback (only used when database is completely unavailable)
// ---------------------------------------------------------------------------

function _fallbackPrompts(
  weather: WeatherData,
  location: Pick<ZimbabweLocation, "name" | "slug">,
  activities: string[],
): SuggestedPrompt[] {
  const prompts: SuggestedPrompt[] = [];
  const c = weather.current;

  if (c.weather_code >= 95) {
    prompts.push({ label: "Storm safety", query: `Is it safe to be outdoors in ${location.name} during this storm?` });
  }
  if (c.temperature_2m <= 3) {
    prompts.push({ label: "Frost precautions", query: `What frost precautions should I take in ${location.name}?` });
  }
  if (c.temperature_2m >= 35) {
    prompts.push({ label: "Heat safety", query: `Is it safe to work outdoors in ${location.name} at ${Math.round(c.temperature_2m)}°C?` });
  }
  if (c.uv_index >= 8) {
    prompts.push({ label: "UV protection", query: `What sun protection do I need with a UV index of ${Math.round(c.uv_index)}?` });
  }
  if (c.precipitation > 0 || (weather.hourly?.precipitation_probability?.[0] ?? 0) > 50) {
    prompts.push({ label: "Rain impact", query: `Will the rain affect my plans in ${location.name} today?` });
  }
  if (c.relative_humidity_2m > 75) {
    prompts.push({ label: "Crop spraying", query: `Is it safe to spray crops in ${location.name} with ${c.relative_humidity_2m}% humidity?` });
  }
  if (c.wind_speed_10m > 30) {
    prompts.push({ label: "Wind impact", query: `How will ${Math.round(c.wind_speed_10m)} km/h wind affect outdoor activities?` });
  }
  if (activities.includes("maize-farming") || activities.includes("tobacco-farming") || activities.includes("horticulture")) {
    prompts.push({ label: "Farming advice", query: `How does today's weather affect farming in ${location.name}?` });
  }
  if (activities.includes("drone-flying")) {
    prompts.push({ label: "Drone conditions", query: `Can I fly my drone safely in ${location.name} today?` });
  }
  if (activities.includes("running") || activities.includes("cycling") || activities.includes("hiking")) {
    prompts.push({ label: "Best time to exercise", query: `What's the best time to exercise outdoors in ${location.name} today?` });
  }
  prompts.push({ label: "Plan my day", query: `What should I plan for today in ${location.name}?` });

  const seen = new Set<string>();
  const unique: SuggestedPrompt[] = [];
  for (const p of prompts) {
    if (!seen.has(p.label)) {
      seen.add(p.label);
      unique.push(p);
    }
    if (unique.length >= 3) break;
  }
  return unique;
}

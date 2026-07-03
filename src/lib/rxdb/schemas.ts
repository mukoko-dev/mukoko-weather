/**
 * RxDB collection schemas for local-first storage.
 *
 * Four collections:
 *   - preferences: device settings (replaces Zustand localStorage persist)
 *   - weather_cache: offline weather data per location
 *   - weather_hints: 3D loading scene hints (replaces localStorage prefix cache)
 *   - suitability_rules: activity suitability rules (replaces in-memory cache)
 */

import type { RxJsonSchema } from "rxdb";

// ---------------------------------------------------------------------------
// Preferences — replaces Zustand persist + device-sync.ts
// ---------------------------------------------------------------------------

export interface PreferencesDocType {
  id: string; // device UUID
  theme: string;
  selectedLocation: string;
  savedLocations: string[];
  locationLabels: Record<string, string>;
  selectedActivities: string[];
  hasOnboarded: boolean;
  /** Windy-style forecast model preference (Open-Meteo model id or "best_match") */
  selectedForecastModel: string;
  updatedAt: number;
}

export const preferencesSchema: RxJsonSchema<PreferencesDocType> = {
  version: 1,
  primaryKey: "id",
  type: "object",
  properties: {
    id: { type: "string", maxLength: 64 },
    theme: { type: "string", enum: ["light", "dark", "system"], default: "system" },
    selectedLocation: { type: "string", default: "" },
    savedLocations: { type: "array", items: { type: "string" }, default: [] },
    locationLabels: { type: "object", additionalProperties: { type: "string" }, default: {} },
    selectedActivities: { type: "array", items: { type: "string" }, default: [] },
    hasOnboarded: { type: "boolean", default: false },
    selectedForecastModel: { type: "string", default: "best_match" },
    updatedAt: { type: "number" },
  },
  required: ["id", "theme", "selectedLocation", "savedLocations", "locationLabels", "selectedActivities", "hasOnboarded", "selectedForecastModel", "updatedAt"],
};

// ---------------------------------------------------------------------------
// Weather cache — offline weather data per location (15-min TTL)
// ---------------------------------------------------------------------------

export interface WeatherCacheDocType {
  slug: string;
  data: string; // JSON-stringified WeatherData
  provider: string; // "tomorrow" | "open-meteo" | "seasonal"
  cachedAt: number;
  expiresAt: number;
}

export const weatherCacheSchema: RxJsonSchema<WeatherCacheDocType> = {
  version: 0,
  primaryKey: "slug",
  type: "object",
  properties: {
    slug: { type: "string", maxLength: 100 },
    data: { type: "string" },
    provider: { type: "string" },
    cachedAt: { type: "number" },
    expiresAt: { type: "number" },
  },
  required: ["slug", "data", "provider", "cachedAt", "expiresAt"],
  indexes: ["expiresAt"],
};

// ---------------------------------------------------------------------------
// Weather hints — 3D loading scene context (replaces localStorage cache)
// ---------------------------------------------------------------------------

export interface WeatherHintDocType {
  slug: string;
  sceneType: string;
  weatherCode: number;
  isDay: boolean;
  timestamp: number;
}

export const weatherHintSchema: RxJsonSchema<WeatherHintDocType> = {
  version: 0,
  primaryKey: "slug",
  type: "object",
  properties: {
    slug: { type: "string", maxLength: 100 },
    sceneType: { type: "string" },
    weatherCode: { type: "number" },
    isDay: { type: "boolean" },
    timestamp: { type: "number" },
  },
  required: ["slug", "sceneType", "weatherCode", "isDay", "timestamp"],
};

// ---------------------------------------------------------------------------
// Suitability rules — cached activity/category evaluation rules
// ---------------------------------------------------------------------------

export interface SuitabilityRuleDocType {
  key: string; // "category:farming" or "activity:stargazing"
  conditions: string; // JSON-stringified condition array
  fallback: string; // JSON-stringified fallback rating (used when no condition matches)
  updatedAt: number;
}

export const suitabilityRuleSchema: RxJsonSchema<SuitabilityRuleDocType> = {
  // v0 → v1: added `fallback`. v0 docs cached rules without their fallback
  // rating, which made every uncached-condition activity evaluate to the
  // hardcoded generic "fair" fallback in suitability.ts — the migration
  // drops those incomplete v0 docs (returning null deletes them) so the
  // cache reports empty and the next fetch pulls complete rules over the
  // network instead of silently keeping the broken local copy.
  version: 1,
  primaryKey: "key",
  type: "object",
  properties: {
    key: { type: "string", maxLength: 100 },
    conditions: { type: "string" }, // JSON-stringified to avoid deep schema
    fallback: { type: "string" }, // JSON-stringified to avoid deep schema
    updatedAt: { type: "number" },
  },
  required: ["key", "conditions", "fallback", "updatedAt"],
};

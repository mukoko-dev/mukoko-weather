/**
 * MongoDB database operations for mukoko weather.
 *
 * Collections:
 *   - weather_cache   : Short-lived weather API response cache (replaces KV WEATHER_CACHE)
 *   - ai_summaries    : Tiered-TTL AI summary cache (replaces KV AI_SUMMARIES)
 *   - weather_history : Historical weather recordings for analytics
 *   - locations       : Zimbabwe locations (mirrors the static array, queryable)
 */

import { getDb } from "./mongo";
import type { WeatherData } from "./weather";
import type { ZimbabweLocation } from "./locations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WeatherCacheDoc {
  locationSlug: string;
  lat: number;
  lon: number;
  data: WeatherData;
  fetchedAt: Date;
  expiresAt: Date;
}

export interface AISummaryDoc {
  locationSlug: string;
  insight: string;
  generatedAt: Date;
  weatherSnapshot: {
    temperature: number;
    weatherCode: number;
  };
  expiresAt: Date;
  tier: 1 | 2 | 3;
}

export interface WeatherHistoryDoc {
  locationSlug: string;
  date: string; // YYYY-MM-DD
  current: WeatherData["current"];
  hourly: WeatherData["hourly"];
  daily: WeatherData["daily"];
  recordedAt: Date;
}

export interface LocationDoc extends ZimbabweLocation {
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Collection accessors
// ---------------------------------------------------------------------------

function weatherCacheCollection() {
  return getDb().collection<WeatherCacheDoc>("weather_cache");
}

function aiSummariesCollection() {
  return getDb().collection<AISummaryDoc>("ai_summaries");
}

function weatherHistoryCollection() {
  return getDb().collection<WeatherHistoryDoc>("weather_history");
}

function locationsCollection() {
  return getDb().collection<LocationDoc>("locations");
}

// ---------------------------------------------------------------------------
// Indexes — call once on app startup (idempotent)
// ---------------------------------------------------------------------------

export async function ensureIndexes(): Promise<void> {
  await Promise.all([
    // Weather cache: one doc per location, auto-expire
    weatherCacheCollection().createIndex({ locationSlug: 1 }, { unique: true }),
    weatherCacheCollection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

    // AI summaries: one doc per location, auto-expire
    aiSummariesCollection().createIndex({ locationSlug: 1 }, { unique: true }),
    aiSummariesCollection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),

    // Weather history: one doc per location per day, query by date range
    weatherHistoryCollection().createIndex({ locationSlug: 1, date: -1 }, { unique: true }),
    weatherHistoryCollection().createIndex({ recordedAt: 1 }),

    // Locations: by slug (unique) and by tags
    locationsCollection().createIndex({ slug: 1 }, { unique: true }),
    locationsCollection().createIndex({ tags: 1 }),
  ]);
}

// ---------------------------------------------------------------------------
// Weather cache operations
// ---------------------------------------------------------------------------

const WEATHER_CACHE_TTL_SECONDS = 900; // 15 minutes

export async function getCachedWeather(
  locationSlug: string,
): Promise<WeatherData | null> {
  const doc = await weatherCacheCollection().findOne({
    locationSlug,
    expiresAt: { $gt: new Date() },
  });
  return doc?.data ?? null;
}

export async function setCachedWeather(
  locationSlug: string,
  lat: number,
  lon: number,
  data: WeatherData,
): Promise<void> {
  const now = new Date();
  await weatherCacheCollection().updateOne(
    { locationSlug },
    {
      $set: {
        lat,
        lon,
        data,
        fetchedAt: now,
        expiresAt: new Date(now.getTime() + WEATHER_CACHE_TTL_SECONDS * 1000),
      },
    },
    { upsert: true },
  );
}

// ---------------------------------------------------------------------------
// AI summary cache operations (tiered TTL, replaces kv-cache.ts)
// ---------------------------------------------------------------------------

// Tier 1: Major cities — 30 min TTL
const TIER_1_SLUGS = new Set([
  "harare", "bulawayo", "mutare", "gweru", "masvingo",
  "kwekwe", "kadoma", "marondera", "chinhoyi", "victoria-falls",
]);

// Tier 2: Active areas — 60 min TTL
const TIER_2_TAGS = new Set(["farming", "mining", "education", "border"]);

const TTL_TIER_1 = 1800;  // 30 minutes
const TTL_TIER_2 = 3600;  // 60 minutes
const TTL_TIER_3 = 7200;  // 120 minutes

export function getTtlForLocation(
  locationSlug: string,
  tags: string[] = [],
): { seconds: number; tier: 1 | 2 | 3 } {
  if (TIER_1_SLUGS.has(locationSlug)) return { seconds: TTL_TIER_1, tier: 1 };
  if (tags.some((t) => TIER_2_TAGS.has(t))) return { seconds: TTL_TIER_2, tier: 2 };
  return { seconds: TTL_TIER_3, tier: 3 };
}

export interface CachedAISummary {
  insight: string;
  generatedAt: string; // ISO timestamp
  locationSlug: string;
  weatherSnapshot: {
    temperature: number;
    weatherCode: number;
  };
}

export async function getCachedAISummary(
  locationSlug: string,
): Promise<AISummaryDoc | null> {
  return aiSummariesCollection().findOne({
    locationSlug,
    expiresAt: { $gt: new Date() },
  });
}

export async function setCachedAISummary(
  locationSlug: string,
  insight: string,
  weatherSnapshot: { temperature: number; weatherCode: number },
  tags: string[] = [],
): Promise<void> {
  const now = new Date();
  const { seconds: ttlSeconds, tier } = getTtlForLocation(locationSlug, tags);

  await aiSummariesCollection().updateOne(
    { locationSlug },
    {
      $set: {
        insight,
        generatedAt: now,
        weatherSnapshot,
        expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
        tier,
      },
    },
    { upsert: true },
  );
}

/**
 * Check if the cached summary is stale (weather changed dramatically).
 * Temperature shifted >5C or weather code changed => stale.
 */
export function isSummaryStale(
  cached: AISummaryDoc,
  currentTemp: number,
  currentWeatherCode: number,
): boolean {
  const tempDelta = Math.abs(cached.weatherSnapshot.temperature - currentTemp);
  const codeChanged = cached.weatherSnapshot.weatherCode !== currentWeatherCode;
  return tempDelta > 5 || codeChanged;
}

// ---------------------------------------------------------------------------
// Historical weather recording
// ---------------------------------------------------------------------------

export async function recordWeatherHistory(
  locationSlug: string,
  data: WeatherData,
): Promise<void> {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

  await weatherHistoryCollection().updateOne(
    { locationSlug, date: dateStr },
    {
      $set: {
        current: data.current,
        hourly: data.hourly,
        daily: data.daily,
        recordedAt: now,
      },
    },
    { upsert: true },
  );
}

export async function getWeatherHistory(
  locationSlug: string,
  days: number = 30,
): Promise<WeatherHistoryDoc[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  return weatherHistoryCollection()
    .find({
      locationSlug,
      recordedAt: { $gte: cutoff },
    })
    .sort({ date: -1 })
    .toArray();
}

// ---------------------------------------------------------------------------
// Location operations (sync static data to MongoDB)
// ---------------------------------------------------------------------------

export async function syncLocations(
  locations: ZimbabweLocation[],
): Promise<void> {
  const now = new Date();
  const bulkOps = locations.map((loc) => ({
    updateOne: {
      filter: { slug: loc.slug },
      update: { $set: { ...loc, updatedAt: now } },
      upsert: true,
    },
  }));
  if (bulkOps.length > 0) {
    await locationsCollection().bulkWrite(bulkOps);
  }
}

export async function getLocationFromDb(
  slug: string,
): Promise<LocationDoc | null> {
  return locationsCollection().findOne({ slug });
}

export async function getLocationsByTagFromDb(
  tag: string,
): Promise<LocationDoc[]> {
  return locationsCollection().find({ tags: tag }).toArray();
}

export async function getAllLocationsFromDb(): Promise<LocationDoc[]> {
  return locationsCollection().find({}).toArray();
}

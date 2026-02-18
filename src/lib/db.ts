/**
 * MongoDB database operations for mukoko weather.
 *
 * Collections:
 *   - weather_cache   : Short-lived weather API response cache (replaces KV WEATHER_CACHE)
 *   - ai_summaries    : Tiered-TTL AI summary cache (replaces KV AI_SUMMARIES)
 *   - weather_history : Historical weather recordings for analytics
 *   - locations       : Zimbabwe locations (single source of truth)
 *   - activities      : User activities for personalized weather insights
 */

import { getDb } from "./mongo";
import { fetchWeather, createFallbackWeather, type WeatherData } from "./weather";
import { fetchWeatherFromTomorrow, TomorrowRateLimitError } from "./tomorrow";
import { logWarn, logError } from "./observability";
import type { ZimbabweLocation } from "./locations";
import type { Activity, ActivityCategory } from "./activities";

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
  /** Activity-specific insights — only present when Tomorrow.io was the provider */
  insights?: WeatherData["insights"];
  recordedAt: Date;
}

export interface LocationDoc extends ZimbabweLocation {
  updatedAt: Date;
}

export interface ActivityDoc extends Activity {
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

function activitiesCollection() {
  return getDb().collection<ActivityDoc>("activities");
}

export function rateLimitsCollection() {
  return getDb().collection<{ key: string; count: number; expiresAt: Date }>("rate_limits");
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

    // Locations: by slug (unique), by tags, text search, geospatial
    locationsCollection().createIndex({ slug: 1 }, { unique: true }),
    locationsCollection().createIndex({ tags: 1 }),
    locationsCollection().createIndex(
      { name: "text", province: "text", slug: "text" },
      { weights: { name: 10, province: 5, slug: 3 }, name: "location_text_search" },
    ),
    locationsCollection().createIndex({ location: "2dsphere" }),

    // Activities: by id (unique), by category, text search
    activitiesCollection().createIndex({ id: 1 }, { unique: true }),
    activitiesCollection().createIndex({ category: 1 }),
    activitiesCollection().createIndex(
      { label: "text", description: "text", category: "text" },
      { weights: { label: 10, description: 5, category: 3 }, name: "activity_text_search" },
    ),

    // API keys: one key per provider
    apiKeysCollection().createIndex({ provider: 1 }, { unique: true }),

    // Rate limits: auto-expire counters for abuse prevention
    rateLimitsCollection().createIndex({ key: 1 }, { unique: true }),
    rateLimitsCollection().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
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
// Unified weather fetch — cache-first, then APIs, then seasonal fallback
// ---------------------------------------------------------------------------

export interface WeatherResult {
  data: WeatherData;
  /** "cache" | "tomorrow" | "open-meteo" | "fallback" */
  source: string;
}

/**
 * Get weather data for a location, checking MongoDB cache first.
 * On cache miss, fetches from Tomorrow.io → Open-Meteo → seasonal fallback.
 * Results are stored in MongoDB so subsequent requests are served from cache.
 * This ensures external APIs are called at most once per 15-min TTL window
 * regardless of how many users request the same location.
 */
export async function getWeatherForLocation(
  slug: string,
  lat: number,
  lon: number,
  elevation: number,
): Promise<WeatherResult> {
  // 1. Try MongoDB cache
  try {
    const cached = await getCachedWeather(slug);
    if (cached) return { data: cached, source: "cache" };
  } catch {
    // DB unavailable — proceed to fetch from APIs
  }

  // 2. Try Tomorrow.io (richer data with activity insights)
  let data: WeatherData | null = null;
  let source = "open-meteo";

  try {
    const tomorrowKey = await getApiKey("tomorrow").catch(() => null);
    if (tomorrowKey) {
      try {
        data = await fetchWeatherFromTomorrow(lat, lon, tomorrowKey);
        source = "tomorrow";
      } catch (err) {
        logWarn({
          source: "tomorrow-io",
          location: slug,
          message: err instanceof TomorrowRateLimitError
            ? "Tomorrow.io rate limit, falling back to Open-Meteo"
            : "Tomorrow.io fetch failed, falling back to Open-Meteo",
          error: err,
        });
      }
    }
  } catch {
    // getApiKey failed (DB down) — skip Tomorrow.io
  }

  // 3. Try Open-Meteo
  if (!data) {
    try {
      data = await fetchWeather(lat, lon);
      source = "open-meteo";
    } catch (err) {
      logError({
        source: "open-meteo",
        severity: "high",
        location: slug,
        message: "Open-Meteo fetch failed",
        error: err,
      });
    }
  }

  // 4. Seasonal fallback — guarantees the page always renders
  if (!data) {
    return { data: createFallbackWeather(lat, lon, elevation), source: "fallback" };
  }

  // Store in MongoDB cache + record history (fire-and-forget, don't block response)
  Promise.all([
    setCachedWeather(slug, lat, lon, data),
    recordWeatherHistory(slug, data),
  ]).catch((err) => logError({
    source: "mongodb",
    severity: "low",
    location: slug,
    message: "Failed to cache weather data",
    error: err,
  }));

  return { data, source };
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fields: Record<string, any> = {
    current: data.current,
    hourly: data.hourly,
    daily: data.daily,
    recordedAt: now,
  };
  if (data.insights) fields.insights = data.insights;

  await weatherHistoryCollection().updateOne(
    { locationSlug, date: dateStr },
    { $set: fields },
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
// API key storage (provider keys stored in MongoDB, not env vars)
// ---------------------------------------------------------------------------

export interface ApiKeyDoc {
  provider: string;
  key: string;
  updatedAt: Date;
}

function apiKeysCollection() {
  return getDb().collection<ApiKeyDoc>("api_keys");
}

export async function getApiKey(provider: string): Promise<string | null> {
  const doc = await apiKeysCollection().findOne({ provider });
  return doc?.key ?? null;
}

export async function setApiKey(provider: string, key: string): Promise<void> {
  await apiKeysCollection().updateOne(
    { provider },
    { $set: { key, updatedAt: new Date() } },
    { upsert: true },
  );
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
      update: {
        $set: {
          ...loc,
          // GeoJSON Point for 2dsphere queries (note: GeoJSON uses [lon, lat] order)
          location: { type: "Point", coordinates: [loc.lon, loc.lat] },
          updatedAt: now,
        },
      },
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

/** Insert a new community-contributed location */
export async function createLocation(
  location: ZimbabweLocation,
): Promise<LocationDoc> {
  const now = new Date();
  const doc = {
    ...location,
    location: { type: "Point" as const, coordinates: [location.lon, location.lat] },
    updatedAt: now,
  };
  await locationsCollection().insertOne(doc as unknown as LocationDoc);
  return { ...location, updatedAt: now };
}

/** Check if a location already exists within a given radius */
export async function findDuplicateLocation(
  lat: number,
  lon: number,
  radiusKm: number = 5,
): Promise<LocationDoc | null> {
  const results = await findNearestLocationsFromDb(lat, lon, { limit: 1, maxDistanceKm: radiusKm });
  return results[0] ?? null;
}

// ---------------------------------------------------------------------------
// Search operations (MongoDB text search + geospatial)
// ---------------------------------------------------------------------------

export interface SearchResult {
  locations: LocationDoc[];
  total: number;
}

/**
 * Full-text search across locations using MongoDB text index.
 * Supports fuzzy matching via text score ranking.
 * Results are sorted by relevance (text score).
 */
export async function searchLocationsFromDb(
  query: string,
  options: { tag?: string; limit?: number; skip?: number } = {},
): Promise<SearchResult> {
  const { tag, limit = 20, skip = 0 } = options;
  const q = query.trim();

  // Build filter
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const filter: Record<string, any> = {};

  if (q) {
    filter.$text = { $search: q };
  }

  if (tag) {
    filter.tags = tag;
  }

  const col = locationsCollection();

  const [locations, total] = await Promise.all([
    q
      ? col
          .find(filter)
          .project({ score: { $meta: "textScore" as const } })
          .sort({ score: { $meta: "textScore" as const } })
          .skip(skip)
          .limit(limit)
          .toArray() as Promise<LocationDoc[]>
      : col
          .find(filter)
          .sort({ name: 1 })
          .skip(skip)
          .limit(limit)
          .toArray() as Promise<LocationDoc[]>,
    col.countDocuments(filter),
  ]);

  return { locations, total };
}

/**
 * Find nearest locations to coordinates using MongoDB 2dsphere index.
 * Returns locations sorted by distance (nearest first).
 */
export async function findNearestLocationsFromDb(
  lat: number,
  lon: number,
  options: { limit?: number; maxDistanceKm?: number } = {},
): Promise<LocationDoc[]> {
  const { limit = 10, maxDistanceKm = 200 } = options;

  return locationsCollection().find({
    location: {
      $near: {
        $geometry: { type: "Point", coordinates: [lon, lat] },
        $maxDistance: maxDistanceKm * 1000, // MongoDB uses metres
      },
    },
  }).limit(limit).toArray() as Promise<LocationDoc[]>;
}

/**
 * Get all distinct tags with location counts.
 */
export async function getTagCounts(): Promise<{ tag: string; count: number }[]> {
  return locationsCollection().aggregate<{ tag: string; count: number }>([
    { $unwind: "$tags" },
    { $group: { _id: "$tags", count: { $sum: 1 } } },
    { $project: { _id: 0, tag: "$_id", count: 1 } },
    { $sort: { count: -1 } },
  ]).toArray();
}

/**
 * Get location and province counts for stats (e.g., footer).
 */
export async function getLocationStats(): Promise<{ locations: number; provinces: number }> {
  const [locations, provinces] = await Promise.all([
    locationsCollection().countDocuments(),
    locationsCollection().distinct("province").then((p) => p.length),
  ]);
  return { locations, provinces };
}

// ---------------------------------------------------------------------------
// Activity operations (sync seed data to MongoDB, query from MongoDB)
// ---------------------------------------------------------------------------

export async function syncActivities(
  activities: Activity[],
): Promise<void> {
  const now = new Date();
  const bulkOps = activities.map((act) => ({
    updateOne: {
      filter: { id: act.id },
      update: {
        $set: {
          ...act,
          updatedAt: now,
        },
      },
      upsert: true,
    },
  }));
  if (bulkOps.length > 0) {
    await activitiesCollection().bulkWrite(bulkOps);
  }
}

export async function getAllActivitiesFromDb(): Promise<ActivityDoc[]> {
  return activitiesCollection().find({}).sort({ category: 1, label: 1 }).toArray();
}

export async function getActivitiesByCategoryFromDb(
  category: ActivityCategory,
): Promise<ActivityDoc[]> {
  return activitiesCollection().find({ category }).sort({ label: 1 }).toArray();
}

export async function getActivityByIdFromDb(
  id: string,
): Promise<ActivityDoc | null> {
  return activitiesCollection().findOne({ id });
}

export async function getActivityLabelsFromDb(
  ids: string[],
): Promise<string[]> {
  const docs = await activitiesCollection().find({ id: { $in: ids } }).toArray();
  return docs.map((d) => d.label);
}

export async function searchActivitiesFromDb(
  query: string,
): Promise<ActivityDoc[]> {
  const q = query.trim();
  if (!q) return getAllActivitiesFromDb();
  return activitiesCollection()
    .find({ $text: { $search: q } })
    .project({ score: { $meta: "textScore" as const } })
    .sort({ score: { $meta: "textScore" as const } })
    .toArray() as Promise<ActivityDoc[]>;
}

export async function getActivityCategoriesFromDb(): Promise<ActivityCategory[]> {
  return activitiesCollection().distinct("category") as Promise<ActivityCategory[]>;
}

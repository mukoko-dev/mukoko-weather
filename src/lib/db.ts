/**
 * MongoDB database operations for mukoko weather.
 *
 * Collections:
 *   - weather_cache   : Short-lived weather API response cache (replaces KV WEATHER_CACHE)
 *   - ai_summaries    : Tiered-TTL AI summary cache (replaces KV AI_SUMMARIES)
 *   - weather_history : Historical weather recordings for analytics
 *   - locations       : Locations (single source of truth — Zimbabwe + Africa + ASEAN)
 *   - countries       : Country metadata (auto-grown as locations are added)
 *   - provinces       : Province/state metadata (auto-grown as locations are added)
 *   - activities      : User activities for personalized weather insights
 *   - regions         : Supported geographic regions (replaces SUPPORTED_REGIONS array)
 *   - tags            : Location tag metadata (replaces TAG_LABELS / TAG_META constants)
 *   - seasons         : Country-specific season definitions (replaces getZimbabweSeason logic)
 */

import { getDb } from "./mongo";
import { fetchWeather, createFallbackWeather, getZimbabweSeason, type WeatherData, type ZimbabweSeason } from "./weather";
import { fetchWeatherFromTomorrow, TomorrowRateLimitError } from "./tomorrow";
import { logWarn, logError } from "./observability";
import type { ZimbabweLocation } from "./locations";
import type { Activity, ActivityCategory } from "./activities";
import { generateProvinceSlug, type Country, type Province } from "./countries";
import type { RegionDoc } from "./seed-regions";
import type { TagDoc } from "./seed-tags";
import type { SeasonDoc } from "./seed-seasons";

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

export interface CountryDoc extends Country {
  updatedAt: Date;
}

export interface ProvinceDoc extends Province {
  updatedAt: Date;
}

// Re-export seed types so callers only need to import from db.ts
export type { RegionDoc, TagDoc, SeasonDoc };

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

function countriesCollection() {
  return getDb().collection<CountryDoc>("countries");
}

function provincesCollection() {
  return getDb().collection<ProvinceDoc>("provinces");
}

function regionsCollection() {
  return getDb().collection<RegionDoc>("regions");
}

function tagsCollection() {
  return getDb().collection<TagDoc>("tags");
}

function seasonsCollection() {
  return getDb().collection<SeasonDoc>("seasons");
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

    // Countries: by code (unique), by region
    countriesCollection().createIndex({ code: 1 }, { unique: true }),
    countriesCollection().createIndex({ region: 1 }),

    // Provinces: by slug (unique), by countryCode
    provincesCollection().createIndex({ slug: 1 }, { unique: true }),
    provincesCollection().createIndex({ countryCode: 1 }),

    // Locations: by provinceSlug + country for hierarchy queries
    locationsCollection().createIndex({ provinceSlug: 1 }),
    locationsCollection().createIndex({ country: 1 }),

    // Regions: by id (unique), by active flag
    regionsCollection().createIndex({ id: 1 }, { unique: true }),
    regionsCollection().createIndex({ active: 1 }),

    // Tags: by slug (unique), by featured + order for explore page
    tagsCollection().createIndex({ slug: 1 }, { unique: true }),
    tagsCollection().createIndex({ featured: 1, order: 1 }),

    // Seasons: by countryCode for date lookups
    seasonsCollection().createIndex({ countryCode: 1 }),
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
  const bulkOps = locations.map((loc) => {
    // Always store country — ZW seed locations don't set it on the object
    // so spreading ...loc would leave the field absent from MongoDB, breaking
    // all queries that filter by { country: "ZW" } (hierarchy pages, counts, sitemap).
    const country = loc.country ?? "ZW";
    const provinceSlug = loc.provinceSlug ??
      generateProvinceSlug(loc.province, country);
    return {
      updateOne: {
        filter: { slug: loc.slug },
        update: {
          $set: {
            ...loc,
            country,
            provinceSlug,
            // GeoJSON Point for 2dsphere queries (note: GeoJSON uses [lon, lat] order)
            location: { type: "Point", coordinates: [loc.lon, loc.lat] },
            updatedAt: now,
          },
        },
        upsert: true,
      },
    };
  });
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

// ---------------------------------------------------------------------------
// Country operations
// ---------------------------------------------------------------------------

export async function syncCountries(countries: Country[]): Promise<void> {
  const now = new Date();
  const bulkOps = countries.map((c) => ({
    updateOne: {
      filter: { code: c.code },
      update: { $set: { ...c, updatedAt: now } },
      upsert: true,
    },
  }));
  if (bulkOps.length > 0) {
    await countriesCollection().bulkWrite(bulkOps);
  }
}

export async function upsertCountry(country: Country): Promise<void> {
  await countriesCollection().updateOne(
    { code: country.code },
    {
      // Always update mutable fields; use $setOnInsert for region so curated
      // seed data (e.g. "Southern Africa") is never overwritten by "Unknown"
      // from a geocoding call.
      $set: { name: country.name, supported: country.supported, updatedAt: new Date() },
      $setOnInsert: { region: country.region },
    },
    { upsert: true },
  );
}

/**
 * Returns countries that have at least one location. This prevents seeded
 * countries with no locations (e.g. Djibouti) from appearing in explore pages.
 * Uses a single aggregation pipeline with $lookup to avoid two sequential round-trips.
 */
export async function getAllCountries(): Promise<CountryDoc[]> {
  return countriesCollection().aggregate<CountryDoc>([
    {
      $lookup: {
        from: "locations",
        localField: "code",
        foreignField: "country",
        // Check existence only — limit to 1 to avoid loading full location docs
        pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }],
        as: "_locs",
      },
    },
    { $match: { _locs: { $ne: [] } } },
    { $project: { _locs: 0 } },
    { $sort: { region: 1, name: 1 } },
  ]).toArray();
}

export async function getCountryByCode(code: string): Promise<CountryDoc | null> {
  return countriesCollection().findOne({ code: code.toUpperCase() });
}

/** Get a country with the count of its locations */
export async function getCountryWithStats(
  code: string,
): Promise<(CountryDoc & { locationCount: number }) | null> {
  const [country, locationCount] = await Promise.all([
    getCountryByCode(code),
    locationsCollection().countDocuments({ country: code.toUpperCase() }),
  ]);
  if (!country) return null;
  return { ...country, locationCount };
}

// ---------------------------------------------------------------------------
// Province operations
// ---------------------------------------------------------------------------

export async function syncProvinces(provinces: Province[]): Promise<void> {
  const now = new Date();
  const bulkOps = provinces.map((p) => ({
    updateOne: {
      filter: { slug: p.slug },
      update: { $set: { ...p, updatedAt: now } },
      upsert: true,
    },
  }));
  if (bulkOps.length > 0) {
    await provincesCollection().bulkWrite(bulkOps);
  }
}

export async function upsertProvince(province: Province): Promise<void> {
  await provincesCollection().updateOne(
    { slug: province.slug },
    {
      // name uses $setOnInsert so geocoded data never overwrites curated seed names.
      // syncProvinces() (db-init) always uses $set and will overwrite with seeded data.
      $set: { countryCode: province.countryCode, updatedAt: new Date() },
      $setOnInsert: { name: province.name },
    },
    { upsert: true },
  );
}

/**
 * Get provinces for a country without location counts.
 * Use `getProvincesWithLocationCounts` instead when rendering province cards
 * that need to show how many locations each province has (avoids N+1 queries).
 * This simpler version is useful when you only need the province list itself
 * (e.g., admin tools, data migration scripts).
 */
export async function getProvincesByCountry(countryCode: string): Promise<ProvinceDoc[]> {
  return provincesCollection()
    .find({ countryCode: countryCode.toUpperCase() })
    .sort({ name: 1 })
    .toArray();
}

export async function getLocationsByCountry(countryCode: string): Promise<LocationDoc[]> {
  return locationsCollection()
    .find({ country: countryCode.toUpperCase() })
    .sort({ name: 1 })
    .toArray();
}

export async function getLocationsByProvince(provinceSlug: string): Promise<LocationDoc[]> {
  return locationsCollection()
    .find({ provinceSlug })
    .sort({ name: 1 })
    .toArray();
}

/** Get a single province by its slug */
export async function getProvinceBySlug(slug: string): Promise<ProvinceDoc | null> {
  return provincesCollection().findOne({ slug });
}

/** Get all provinces (for sitemap generation) */
export async function getAllProvinces(): Promise<ProvinceDoc[]> {
  return provincesCollection().find({}).sort({ countryCode: 1, name: 1 }).toArray();
}

/**
 * Get all country codes that have at least one location (for sitemap generation).
 * Derives directly from the locations collection to stay consistent with
 * getAllCountries() — only countries with real data are indexed.
 */
export async function getAllCountryCodes(): Promise<string[]> {
  const codes = await locationsCollection().distinct("country");
  return codes
    .filter((c): c is string => !!c)
    .map((c) => c.toUpperCase());
}

/** Get all location slugs + tags with minimal projection (for sitemap generation) */
export async function getAllLocationSlugsForSitemap(): Promise<{ slug: string; tags: string[] }[]> {
  return locationsCollection()
    .find({}, { projection: { slug: 1, tags: 1, _id: 0 } })
    .toArray() as Promise<{ slug: string; tags: string[] }[]>;
}

/**
 * Get provinces for a country with their location counts in a single aggregation,
 * eliminating the N+1 query pattern.
 */
export async function getProvincesWithLocationCounts(
  countryCode: string,
): Promise<(ProvinceDoc & { locationCount: number })[]> {
  const upper = countryCode.toUpperCase();

  const [provinces, counts] = await Promise.all([
    provincesCollection().find({ countryCode: upper }).sort({ name: 1 }).toArray(),
    locationsCollection()
      .aggregate<{ _id: string; count: number }>([
        { $match: { country: upper } },
        { $group: { _id: "$provinceSlug", count: { $sum: 1 } } },
      ])
      .toArray(),
  ]);

  const countMap: Record<string, number> = {};
  for (const c of counts) {
    if (c._id) countMap[c._id] = c.count;
  }

  return provinces.map((p) => ({ ...p, locationCount: countMap[p.slug] ?? 0 }));
}

// ---------------------------------------------------------------------------
// Region operations (replaces SUPPORTED_REGIONS static array at runtime)
// ---------------------------------------------------------------------------

export async function syncRegions(regions: RegionDoc[]): Promise<void> {
  const bulkOps = regions.map((r) => ({
    updateOne: {
      filter: { id: r.id },
      update: { $set: { ...r } },
      upsert: true,
    },
  }));
  if (bulkOps.length > 0) {
    await regionsCollection().bulkWrite(bulkOps);
  }
}

export async function getActiveRegions(): Promise<RegionDoc[]> {
  return regionsCollection().find({ active: true }).toArray();
}

export async function getAllRegions(): Promise<RegionDoc[]> {
  return regionsCollection().find({}).toArray();
}

// Module-level cache for active regions. Regions are nearly static (only change
// when a new region is added to MongoDB), so we load once per warm function
// instance and skip repeated DB round-trips on subsequent requests.
let _regionCache: RegionDoc[] | null = null;

/**
 * Async region check — replaces the synchronous isInSupportedRegion() from locations.ts.
 * Falls back to rejecting all coordinates if the regions collection is empty.
 */
export async function isInSupportedRegionFromDb(lat: number, lon: number): Promise<boolean> {
  // Retry when cache is null OR when it's an empty array (db-init may not have run yet).
  // An empty array is not a valid permanent sentinel — regions could be added shortly after.
  if (_regionCache === null || _regionCache.length === 0) {
    try {
      _regionCache = await getActiveRegions();
    } catch {
      // DB unavailable — do not cache failure, reject to be safe
      return false;
    }
  }
  const regions = _regionCache;
  if (regions.length === 0) return false;
  return regions.some(
    (r) =>
      lat >= r.south - r.padding &&
      lat <= r.north + r.padding &&
      lon >= r.west - r.padding &&
      lon <= r.east + r.padding,
  );
}

/** Clear the in-memory region cache (for testing). */
export function _clearRegionCache(): void {
  _regionCache = null;
}

// ---------------------------------------------------------------------------
// Tag operations (replaces TAG_LABELS / TAG_META static constants at runtime)
// ---------------------------------------------------------------------------

export async function syncTags(tags: TagDoc[]): Promise<void> {
  const bulkOps = tags.map((t) => ({
    updateOne: {
      filter: { slug: t.slug },
      update: { $set: { ...t } },
      upsert: true,
    },
  }));
  if (bulkOps.length > 0) {
    await tagsCollection().bulkWrite(bulkOps);
  }
}

export async function getAllTagsFromDb(): Promise<TagDoc[]> {
  return tagsCollection().find({}).sort({ order: 1 }).toArray();
}

export async function getTagBySlug(slug: string): Promise<TagDoc | null> {
  return tagsCollection().findOne({ slug });
}

export async function getFeaturedTagsFromDb(): Promise<TagDoc[]> {
  return tagsCollection().find({ featured: true }).sort({ order: 1 }).toArray();
}

// ---------------------------------------------------------------------------
// Season operations (replaces getZimbabweSeason() hardcoded logic at runtime)
// ---------------------------------------------------------------------------

export async function syncSeasons(seasons: SeasonDoc[]): Promise<void> {
  const bulkOps = seasons.map((s) => ({
    updateOne: {
      filter: { countryCode: s.countryCode, name: s.name },
      update: { $set: { ...s } },
      upsert: true,
    },
  }));
  if (bulkOps.length > 0) {
    await seasonsCollection().bulkWrite(bulkOps);
  }
}

/**
 * Look up the current season for a given date and country.
 * Returns null if no matching season is found (caller should fall back to sync logic).
 */
export async function getSeasonFromDb(
  date: Date,
  countryCode: string,
): Promise<SeasonDoc | null> {
  const month = date.getMonth() + 1; // 1-based
  const seasons = await seasonsCollection()
    .find({ countryCode: countryCode.toUpperCase() })
    .toArray();
  return seasons.find((s) => s.months.includes(month)) ?? null;
}

/**
 * Get the current season for a given date and country code.
 * Reads from the seasons collection; falls back to the sync ZW logic if DB is unavailable.
 * Server-only — do not import in client components.
 */
export async function getSeasonForDate(
  date: Date = new Date(),
  countryCode: string = "ZW",
): Promise<ZimbabweSeason> {
  try {
    const doc = await getSeasonFromDb(date, countryCode);
    if (doc) {
      return { name: doc.name, shona: doc.localName, description: doc.description };
    }
  } catch {
    // DB unavailable — fall through to sync fallback
  }
  return getZimbabweSeason(date);
}

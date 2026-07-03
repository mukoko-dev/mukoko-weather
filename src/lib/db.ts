/**
 * MongoDB database operations for mukoko weather.
 *
 * Phase 0F: `weather.locations` is GONE. All location reads/writes flow
 * through `places.placesGeo` (admin geography) + `places.places` (POIs from
 * OSM/Fundi) via the helpers in `src/lib/places.ts`. The `getLocationFromDb`
 * shim here adapts the platform shape to the legacy `LocationDoc` so server
 * components in `src/app/[location]/*` keep working without changes.
 *
 * Collections:
 *   - weather_cache   : Short-lived weather API response cache (replaces KV WEATHER_CACHE)
 *   - ai_summaries    : Tiered-TTL AI summary cache (replaces KV AI_SUMMARIES)
 *   - weather_history : Historical weather recordings for analytics
 *   - activities      : User activities for personalized weather insights
 *   - regions         : Supported geographic regions (replaces SUPPORTED_REGIONS array)
 *   - tags            : Location tag metadata (replaces TAG_LABELS / TAG_META constants)
 *   - seasons         : Country-specific season definitions (replaces getDefaultSeason logic)
 *   - countries       : Country metadata (display labels, region grouping)
 *   - provinces       : Province/state display metadata
 */

import type {
  Collection,
  Document,
  IndexSpecification,
  CreateIndexesOptions,
} from "mongodb";
import {
  weatherDb,
  placesDb,
  identityDb,
  shamwariDb,
  deviceDb,
  integrationsDb,
} from "./mongo";
import { fetchWeather, createFallbackWeather, getDefaultSeason, synthesizeOpenMeteoInsights, type WeatherData, type Season } from "./weather";
import { fetchWeatherFromTomorrow, TomorrowRateLimitError } from "./tomorrow";
import { logWarn, logError } from "./observability";
import type { WeatherLocation } from "./locations";
import type { Activity, ActivityCategory } from "./activities";
import { generateProvinceSlug, COUNTRIES, PROVINCES, type Country, type Province } from "./countries";
import type { RegionDoc } from "./seed-regions";
import type { TagDoc } from "./seed-tags";
import type { SeasonDoc } from "./seed-seasons";
import type { ActivityCategoryDoc } from "./seed-categories";
import type { AIPromptDoc, AISuggestedPromptRule } from "./seed-ai-prompts";

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

export interface LocationDoc extends WeatherLocation {
  updatedAt: Date;
}

export interface ActivityDoc extends Activity {
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Suitability rules — database-driven weather suitability configuration
// ---------------------------------------------------------------------------

/**
 * A single condition that evaluates a weather insight field against a threshold.
 * When matched, produces the given suitability rating.
 */
export interface SuitabilityCondition {
  /** Weather insight field to check (e.g. "thunderstormProbability", "visibility", "heatStressIndex") */
  field: string;
  /** Comparison operator */
  operator: "gt" | "gte" | "lt" | "lte" | "eq";
  /** Threshold value to compare against */
  value: number;
  /** Suitability level when this condition matches */
  level: "excellent" | "good" | "fair" | "poor";
  /** Display label for this rating */
  label: string;
  /** CSS class for the text color (must use severity tokens) */
  colorClass: string;
  /** CSS class for background (must use severity tokens) */
  bgClass: string;
  /** Human-readable detail message */
  detail: string;
  /** Optional metric template — use {value} as placeholder for the actual value */
  metricTemplate?: string;
}

/**
 * Suitability rule set for a category or specific activity.
 * Conditions are evaluated in order — first match wins.
 * A fallback is always provided for when no condition matches.
 */
export interface SuitabilityRuleDoc {
  /** "category:farming", "category:mining", or "activity:drone-flying" */
  key: string;
  /** Ordered list of conditions — first match wins */
  conditions: SuitabilityCondition[];
  /** Fallback rating when no condition matches */
  fallback: Omit<SuitabilityCondition, "field" | "operator" | "value">;
  updatedAt: Date;
}

export interface CountryDoc extends Country {
  updatedAt: Date;
}

export interface ProvinceDoc extends Province {
  updatedAt: Date;
}

// Re-export seed types so callers only need to import from db.ts
export type { RegionDoc, TagDoc, SeasonDoc, ActivityCategoryDoc, AIPromptDoc, AISuggestedPromptRule };

// ---------------------------------------------------------------------------
// Collection accessors — legacy mukoko collections (now in `weather` DB)
//
// Phase 0B: existing accessors keep working untouched. They now route through
// the appropriate platform DB (mostly `weather`) via the named helpers in
// mongo.ts. Platform collection accessors (camelCase, schema-validated) live
// further down in the "Platform collection accessors" section.
// ---------------------------------------------------------------------------

function weatherCacheCollection() {
  return weatherDb().collection<WeatherCacheDoc>("weather_cache");
}

function aiSummariesCollection() {
  return weatherDb().collection<AISummaryDoc>("ai_summaries");
}

function weatherHistoryCollection() {
  return weatherDb().collection<WeatherHistoryDoc>("weather_history");
}

/* Phase 0F — `weather.locations` is dropped. Any forgotten internal caller
 * is caught by the type system + tests. Public helpers below delegate
 * through `src/lib/places.ts` to `places.placesGeo` / `places.places`. */

function activitiesCollection() {
  return weatherDb().collection<ActivityDoc>("activities");
}

export function rateLimitsCollection() {
  return weatherDb().collection<{ key: string; count: number; expiresAt: Date }>("rate_limits");
}

function regionsCollection() {
  return weatherDb().collection<RegionDoc>("regions");
}

function tagsCollection() {
  return weatherDb().collection<TagDoc>("tags");
}

function seasonsCollection() {
  return weatherDb().collection<SeasonDoc>("seasons");
}

function activityCategoriesCollection() {
  return weatherDb().collection<ActivityCategoryDoc>("activity_categories");
}

function suitabilityRulesCollection() {
  return weatherDb().collection<SuitabilityRuleDoc>("suitability_rules");
}

function aiPromptsCollection() {
  return weatherDb().collection<AIPromptDoc & { updatedAt: Date }>("ai_prompts");
}

function aiSuggestedRulesCollection() {
  return weatherDb().collection<AISuggestedPromptRule & { updatedAt: Date }>("ai_suggested_rules");
}

/**
 * A seeded ICAO airport used for the aviation METAR/TAF feature.
 *
 * Stored in `weather.airports` — a plain reference collection (no strict
 * platform validator), keyed by the ICAO code as its natural `_id` so
 * re-seeding is idempotent and never creates duplicates (same deterministic-id
 * discipline as `air_quality_cache`). The `location` GeoJSON Point powers the
 * `$nearSphere` nearest-airport lookup in `api/py/_airports.py`.
 */
export interface AirportDoc {
  /** ICAO code, uppercase — also the document `_id`. */
  _id: string;
  icao: string;
  name: string;
  lat: number;
  lon: number;
  /** GeoJSON Point `[lon, lat]` for the 2dsphere index. */
  location: { type: "Point"; coordinates: [number, number] };
  updatedAt: Date;
}

function airportsCollection() {
  return weatherDb().collection<AirportDoc>("airports");
}

// ---------------------------------------------------------------------------
// Indexes — call once on app startup (idempotent)
// ---------------------------------------------------------------------------

/**
 * MongoDB error codes for index conflicts.
 *   85 (IndexOptionsConflict)  — an index with the same name exists but with
 *        different options (e.g. requested `unique: true` but the existing one
 *        is non-unique). This is the error that was aborting the whole seed.
 *   86 (IndexKeySpecsConflict) — an index with the same name exists on a
 *        different key spec.
 *   68 (IndexAlreadyExists)    — an equivalent index already exists (benign).
 */
export function isIndexConflictError(err: unknown): boolean {
  const code = (err as { code?: number } | null)?.code;
  return code === 85 || code === 86 || code === 68;
}

/**
 * MongoDB duplicate-key error (11000) — surfaces when trying to build a unique
 * index over a collection that already contains duplicate values, so a
 * drop-and-recreate to `unique` is genuinely unsafe.
 */
function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

/** Compute the default index name MongoDB assigns to a simple key spec. */
function defaultIndexName(keys: IndexSpecification): string {
  return Object.entries(keys as Record<string, unknown>)
    .map(([field, direction]) => `${field}_${direction}`)
    .join("_");
}

/**
 * Create an index resiliently. A single conflicting or failing index must NEVER
 * abort the whole `ensureIndexes` seed run (BUG 2). This helper:
 *
 *   1. Tries `createIndex` normally.
 *   2. On an index-options/spec conflict (Mongo 85/86) for a UNIQUE index,
 *      drop-and-recreate the index to reconcile the options. If that fails
 *      because real duplicate values exist (11000), downgrade to a non-unique
 *      index so reality is matched and seeding continues.
 *   3. Any other error is logged and swallowed — never rethrown.
 *
 * Always resolves; never rejects.
 */
async function safeCreateIndex<T extends Document>(
  collection: Collection<T>,
  keys: IndexSpecification,
  options?: CreateIndexesOptions,
): Promise<void> {
  try {
    await collection.createIndex(keys, options);
    return;
  } catch (err) {
    const namespace = collection.collectionName;

    if (!isIndexConflictError(err)) {
      // Non-conflict failure (e.g. transient): log and continue seeding.
      logWarn({
        source: "mongodb",
        message: `ensureIndexes: skipped index on ${namespace}`,
        error: err instanceof Error ? err : new Error(String(err)),
        meta: { keys },
      });
      return;
    }

    // Conflict. If we genuinely need a unique index, try to reconcile it by
    // dropping the existing (differently-optioned) index and recreating.
    if (options?.unique) {
      const indexName = options.name ?? defaultIndexName(keys);
      try {
        await collection.dropIndex(indexName);
        await collection.createIndex(keys, options);
        return;
      } catch (recreateErr) {
        if (isDuplicateKeyError(recreateErr)) {
          // Real duplicate data — a unique index can't exist. Downgrade to a
          // non-unique index so lookups stay fast and seeding proceeds.
          const { unique: _unique, ...nonUnique } = options;
          try {
            await collection.createIndex(keys, nonUnique);
          } catch {
            /* give up on this one index — never abort the seed */
          }
          logWarn({
            source: "mongodb",
            message: `ensureIndexes: ${namespace}.${indexName} has duplicate values — created non-unique index instead of unique`,
            meta: { keys },
          });
          return;
        }
        // Drop/recreate failed for another reason — log and continue.
        logWarn({
          source: "mongodb",
          message: `ensureIndexes: could not reconcile unique index ${namespace}.${indexName}`,
          error: recreateErr instanceof Error ? recreateErr : new Error(String(recreateErr)),
          meta: { keys },
        });
        return;
      }
    }

    // Non-unique conflict — the existing index is good enough. Log and move on.
    logWarn({
      source: "mongodb",
      message: `ensureIndexes: index already exists with different options on ${namespace} — leaving existing index in place`,
      meta: { keys },
    });
  }
}

export async function ensureIndexes(): Promise<void> {
  // Each index is created independently and resiliently — one conflicting or
  // failing index NEVER aborts the whole seed (so `weather.airports` and every
  // other collection still gets seeded). `safeCreateIndex` never rejects, but
  // we use `allSettled` as a belt-and-braces guard.
  await Promise.allSettled([
    // Weather cache: one doc per location, auto-expire
    safeCreateIndex(weatherCacheCollection(), { locationSlug: 1 }, { unique: true }),
    safeCreateIndex(weatherCacheCollection(), { expiresAt: 1 }, { expireAfterSeconds: 0 }),

    // AI summaries: one doc per location, auto-expire
    safeCreateIndex(aiSummariesCollection(), { locationSlug: 1 }, { unique: true }),
    safeCreateIndex(aiSummariesCollection(), { expiresAt: 1 }, { expireAfterSeconds: 0 }),

    // Weather history: one doc per location per day, query by date range
    safeCreateIndex(weatherHistoryCollection(), { locationSlug: 1, date: -1 }, { unique: true }),
    safeCreateIndex(weatherHistoryCollection(), { recordedAt: 1 }),

    // Locations indexes — Phase 0F: weather.locations is dropped. Geo /
    // text indexes on `places.placesGeo` are managed by the platform.

    // Activities: by id (unique), by category, text search
    safeCreateIndex(activitiesCollection(), { id: 1 }, { unique: true }),
    safeCreateIndex(activitiesCollection(), { category: 1 }),
    safeCreateIndex(
      activitiesCollection(),
      { label: "text", description: "text", category: "text" },
      { weights: { label: 10, description: 5, category: 3 }, name: "activity_text_search" },
    ),

    // API keys: one key per provider
    safeCreateIndex(apiKeysCollection(), { provider: 1 }, { unique: true }),

    // Rate limits: auto-expire counters for abuse prevention
    safeCreateIndex(rateLimitsCollection(), { key: 1 }, { unique: true }),
    safeCreateIndex(rateLimitsCollection(), { expiresAt: 1 }, { expireAfterSeconds: 0 }),

    // Phase 0G: `weather.countries` / `weather.provinces` are dropped. The
    // canonical geographic hierarchy lives in `places.placesGeo` (Fundi-seeded);
    // display/flag data comes from the static COUNTRIES/PROVINCES arrays in
    // `src/lib/countries.ts`. No indexes are managed here anymore.

    // Regions: by id (unique), by active flag
    safeCreateIndex(regionsCollection(), { id: 1 }, { unique: true }),
    safeCreateIndex(regionsCollection(), { active: 1 }),

    // Tags: by slug (unique), by featured + order for explore page
    safeCreateIndex(tagsCollection(), { slug: 1 }, { unique: true }),
    safeCreateIndex(tagsCollection(), { featured: 1, order: 1 }),

    // Seasons: by countryCode for date lookups, TTL for AI-generated entries
    safeCreateIndex(seasonsCollection(), { countryCode: 1 }),
    safeCreateIndex(seasonsCollection(), { expiresAt: 1 }, { expireAfterSeconds: 0 }),

    // Activity categories: by id (unique), by order for display
    safeCreateIndex(activityCategoriesCollection(), { id: 1 }, { unique: true }),
    safeCreateIndex(activityCategoriesCollection(), { order: 1 }),

    // Suitability rules: by key (unique) for lookups
    safeCreateIndex(suitabilityRulesCollection(), { key: 1 }, { unique: true }),

    // AI prompts: by promptKey (unique), by active + order for queries
    safeCreateIndex(aiPromptsCollection(), { promptKey: 1 }, { unique: true }),
    safeCreateIndex(aiPromptsCollection(), { active: 1, order: 1 }),

    // AI suggested rules: by ruleId (unique), by active + category + order
    safeCreateIndex(aiSuggestedRulesCollection(), { ruleId: 1 }, { unique: true }),
    safeCreateIndex(aiSuggestedRulesCollection(), { active: 1, category: 1, order: 1 }),

    // METAR cache: one doc per ICAO station, auto-expire after 30 minutes
    safeCreateIndex(weatherDb().collection("metar_cache"), { icao: 1 }, { unique: true }),
    safeCreateIndex(weatherDb().collection("metar_cache"), { expiresAt: 1 }, { expireAfterSeconds: 0 }),

    // Air quality cache: 1-hour TTL — _id is deterministic ({lat:.4f}_{lon:.4f}),
    // so the unique-by-_id index MongoDB provides for free is the only key index needed.
    safeCreateIndex(weatherDb().collection("air_quality_cache"), { expiresAt: 1 }, { expireAfterSeconds: 0 }),

    // Map tile cache: ~90-min TTL — _id is deterministic ({layer}/{z}/{x}/{y}/{hourBucket}),
    // so the unique-by-_id index MongoDB provides for free is the only key index needed.
    // Drastically cuts Tomorrow.io overlay-tile calls (free tier is ~25 req/hour).
    safeCreateIndex(weatherDb().collection("map_tile_cache"), { expiresAt: 1 }, { expireAfterSeconds: 0 }),

    // Airports: ICAO reference data for METAR/TAF. `_id` is the ICAO code
    // (unique for free); the 2dsphere index powers the $nearSphere
    // nearest-airport lookup in api/py/_airports.py.
    safeCreateIndex(airportsCollection(), { location: "2dsphere" }),
  ]);
}

// ---------------------------------------------------------------------------
// Platform schema constants + helpers (Phase 0B)
//
// All writes into a platform-validated collection MUST include _schemaVersion,
// createdAt, updatedAt, and a `bundu` sub-document. Strict validators
// (validationAction: "error") will reject writes that don't conform.
// See docs/mongodb-schema-map.md for the full schema map.
// ---------------------------------------------------------------------------

/** Schema version stamped onto every new document we write. */
export const PLATFORM_SCHEMA_VERSION = "v3.1";

/** Default country code for the Bundu sub-document. */
export const DEFAULT_COUNTRY_CODE = "ZW";

export interface PlatformStampOptions {
  /** ISO 3166-1 alpha-2 country code (defaults to "ZW"). */
  countryCode?: string;
  /** Optional province slug for the Bundu sub-document. */
  provinceSlug?: string;
}

/**
 * Stamp the platform-required fields onto a document in place and return it.
 *
 * Stamps:
 *   - `_id`            — UUID string (only if missing)
 *   - `_schemaVersion` — `"v3.1"` (only if missing)
 *   - `createdAt`      — UTC now (only if missing)
 *   - `updatedAt`      — UTC now (always overwritten)
 *   - `bundu`          — sub-doc with `countryCode` (+ `provinceSlug` if given)
 *
 * Existing values are preserved — safe to call on a partially-built doc.
 * Call this on every insert into a platform collection.
 */
export function stampPlatformFields<T extends Record<string, unknown>>(
  doc: T,
  opts: PlatformStampOptions = {},
): T & {
  _id: string;
  _schemaVersion: string;
  createdAt: Date;
  updatedAt: Date;
  bundu: { countryCode: string; provinceSlug?: string };
} {
  const { countryCode = DEFAULT_COUNTRY_CODE, provinceSlug } = opts;
  const now = new Date();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = doc as Record<string, any>;
  if (d._id === undefined || d._id === null) d._id = randomUuid();
  if (d._schemaVersion === undefined) d._schemaVersion = PLATFORM_SCHEMA_VERSION;
  if (d.createdAt === undefined) d.createdAt = now;
  d.updatedAt = now;

  const bundu = (d.bundu ??= {} as Record<string, unknown>);
  if (bundu.countryCode === undefined) bundu.countryCode = countryCode;
  if (provinceSlug && bundu.provinceSlug === undefined) bundu.provinceSlug = provinceSlug;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return d as any;
}

/** RFC4122-ish UUID v4 using crypto.randomUUID when available. */
function randomUuid(): string {
  // Node 18+ and modern browsers expose globalThis.crypto.randomUUID().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID() as string;
  }
  // Last-resort fallback. Not cryptographically strong, but acceptable for
  // _id generation; environments without crypto.randomUUID are vanishingly
  // rare on the deploy target (Vercel Node 20).
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// Platform collection accessors (Phase 0B)
//
// New camelCase, schema-validated collections on the shared platform cluster.
// Use these for any new code. Existing call sites can keep using the legacy
// accessors above — both coexist during Phase 0.
// ---------------------------------------------------------------------------

// weather domain
/** StationKit hardware registry — `weather.stations`. */
export function stationsCollection() {
  return weatherDb().collection("stations");
}

/** QC-validated station observations — `weather.observations`. */
export function observationsCollection() {
  return weatherDb().collection("observations");
}

/** Raw station payloads — `weather.stationObservations`. */
export function stationObservationsCollection() {
  return weatherDb().collection("stationObservations");
}

/** CAP-format severe weather alerts — `weather.alerts`. */
export function alertsCollection() {
  return weatherDb().collection("alerts");
}

/** Community weather reports (Waze-style) — `weather.communityReports` (camelCase). */
export function communityReportsCollection() {
  return weatherDb().collection("communityReports");
}

/**
 * Air quality cache — `weather.air_quality_cache`. Deterministic `_id`
 * (`{lat:.4f}_{lon:.4f}`), 1-hour TTL via `expiresAt` index.
 *
 * Read/write owned by the Python backend (`api/py/_air_quality.py`); this
 * accessor exists for parity so future TS callers (e.g., OG image generation
 * with an AQ badge, or a server-rendered AQ chip) don't have to reach into
 * `weatherDb()` directly.
 */
export function airQualityCacheCollection() {
  return weatherDb().collection("air_quality_cache");
}

// places domain
/** Places (landmarks, businesses, parks, etc.) — `places.places`. */
export function placesCollection() {
  return placesDb().collection("places");
}

/** Administrative geography — `places.placesGeo` (camelCase). */
export function placesGeoCollection() {
  return placesDb().collection("placesGeo");
}

export function categoriesCollection() {
  return placesDb().collection("categories");
}

export function routesCollection() {
  return placesDb().collection("routes");
}

/** Per-place community condition reports — `places.conditionReports`. */
export function conditionReportsCollection() {
  return placesDb().collection("conditionReports");
}

// identity domain
/** Canonical user records (OIDC-compliant) — `identity.persons`. */
export function personsCollection() {
  return identityDb().collection("persons");
}

/** Per-person credentials (passkey, WorkOS, OAuth, etc.) — `identity.credentials`. */
export function credentialsCollection() {
  return identityDb().collection("credentials");
}

/** Auth audit trail — `identity.activityLog` (camelCase). */
export function activityLogCollection() {
  return identityDb().collection("activityLog");
}

// shamwari domain
/** Per-user chat sessions — `shamwari.conversations`. */
export function conversationsCollection() {
  return shamwariDb().collection("conversations");
}

/** Chat messages (Anthropic content-block format) — `shamwari.messages`. */
export function messagesCollection() {
  return shamwariDb().collection("messages");
}

/** Cross-app guardrails — `shamwari.guardrails`. */
export function guardrailsCollection() {
  return shamwariDb().collection("guardrails");
}

/** Vector-embedded knowledge resources (RAG) — `shamwari.knowledgeBase`. */
export function knowledgeBaseCollection() {
  return shamwariDb().collection("knowledgeBase");
}

/** Per-person Shamwari preferences — `shamwari.preferences`. */
export function preferencesCollection() {
  return shamwariDb().collection("preferences");
}

// device domain
/** Every device on the platform — `device.devices`. */
export function devicesCollection() {
  return deviceDb().collection("devices");
}

export function commandsCollection() {
  return deviceDb().collection("commands");
}

export function telemetryCollection() {
  return deviceDb().collection("telemetry");
}

/** Device state transition audit log — `device.deviceHistory` (camelCase). */
export function deviceHistoryCollection() {
  return deviceDb().collection("deviceHistory");
}

/**
 * Legacy mukoko device profile sync — now lives in the platform `device` DB.
 * Phase 0D will migrate writers to `device.devices`.
 */
export function deviceProfilesCollection() {
  return deviceDb().collection("device_profiles");
}

// integrations domain
/** External provider catalog (WorkOS, Tomorrow.io, etc.) — `integrations.providers`. */
export function providersCollection() {
  return integrationsDb().collection("providers");
}

/** Per-env/per-country provider configs — `integrations.providerConfigurations`. */
export function providerConfigurationsCollection() {
  return integrationsDb().collection("providerConfigurations");
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
      // Synthesize basic insights from Open-Meteo current data so suitability
      // rules (e.g. drone wind speed) work even when Tomorrow.io is unavailable.
      if (data && !data.insights && data.current) {
        data.insights = synthesizeOpenMeteoInsights(data);
      }
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

// Tier 1: Major cities (by tag) — 30 min TTL
const TIER_1_TAGS = new Set(["city"]);

// Tier 2: Active areas — 60 min TTL
const TIER_2_TAGS = new Set(["farming", "mining", "education", "border"]);

const TTL_TIER_1 = 1800;  // 30 minutes
const TTL_TIER_2 = 3600;  // 60 minutes
const TTL_TIER_3 = 7200;  // 120 minutes

export function getTtlForLocation(
  _locationSlug: string,
  tags: string[] = [],
): { seconds: number; tier: 1 | 2 | 3 } {
  if (tags.some((t) => TIER_1_TAGS.has(t))) return { seconds: TTL_TIER_1, tier: 1 };
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
  // Legacy mukoko API key store. Phase 0D replaces reads from this collection
  // with `integrations.providerConfigurations`. Kept here so existing code
  // keeps working in the meantime.
  return weatherDb().collection<ApiKeyDoc>("api_keys");
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
// Location operations (Phase 0F — delegates to places.placesGeo via places.ts)
// ---------------------------------------------------------------------------

import { LOCATIONS } from "./locations";
import {
  resolveLocationSlug,
  nearestPlacesGeo,
  adaptPlacesGeoToLocationDoc,
} from "./places";

/**
 * Canonical location lookup. Returns the platform `placesGeo` entry adapted
 * to the legacy LocationDoc shape so existing server components keep working.
 *
 * Resolution chain:
 *   slug → placesGeo (by `sourceProvenance.mukokoSlug` or name match)
 *        → adapted shape { slug, name, lat, lon, elevation, province, country, tags, _id }
 *
 * See `src/lib/places.ts` for the full strategy.
 */
export async function getLocationFromDb(
  slug: string,
): Promise<LocationDoc | null> {
  const adapted = await resolveLocationSlug(slug);
  if (!adapted) return null;
  // AdaptedLocation already matches LocationDoc — re-cast for the legacy type.
  return {
    ...adapted,
    updatedAt: adapted.updatedAt ?? new Date(),
  } as LocationDoc;
}

/**
 * Filter the static seed by tag. placesGeo doesn't carry mukoko tags, so the
 * tag-browse surfaces (`/explore/[tag]`) read the seed catalog directly.
 * Community locations created via add_location don't surface here unless
 * they're added to the static seed list — by design, the tag taxonomy is
 * curated, not user-driven.
 */
export async function getLocationsByTagFromDb(
  tag: string,
): Promise<LocationDoc[]> {
  const now = new Date();
  return LOCATIONS.filter((loc) => loc.tags.includes(tag)).map((loc) => ({
    ...loc,
    updatedAt: now,
  })) as LocationDoc[];
}

/**
 * All known locations from the static seed catalog. Used for AI context
 * building, sitemaps, and the explore page chooser. Community-created
 * placesGeo entries are NOT included here — the seed is the canonical list
 * of clean URL slugs the app ships with.
 */
export async function getAllLocationsFromDb(): Promise<LocationDoc[]> {
  const now = new Date();
  return LOCATIONS.map((loc) => ({ ...loc, updatedAt: now })) as LocationDoc[];
}

/** Limited list for AI prompt context. */
export async function getLocationsForContext(limit: number): Promise<LocationDoc[]> {
  const all = await getAllLocationsFromDb();
  return all
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** Count of known seed locations. */
export async function getLocationCount(): Promise<number> {
  return LOCATIONS.length;
}

/** Check if a location already exists within a given radius (delegates to placesGeo). */
export async function findDuplicateLocation(
  lat: number,
  lon: number,
  radiusKm: number = 5,
): Promise<LocationDoc | null> {
  const doc = await nearestPlacesGeo(lat, lon, radiusKm);
  if (!doc) return null;
  const adapted = await adaptPlacesGeoToLocationDoc(doc, {
    cleanSlug: doc.sourceProvenance?.mukokoSlug ?? doc.slug ?? "",
  });
  return { ...adapted, updatedAt: new Date() } as LocationDoc;
}

// ---------------------------------------------------------------------------
// Search operations (Phase 0F — placesGeo-backed)
// ---------------------------------------------------------------------------

export interface SearchResult {
  locations: LocationDoc[];
  total: number;
}

/** Retained for backwards-compat with existing tests/imports. */
const ATLAS_RETRY_AFTER_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check whether a MongoDB error indicates a missing Atlas Search index
 * (permanent) vs. a transient failure. Used by the activity search path.
 */
function isAtlasSearchIndexMissing(err: unknown): boolean {
  if (err && typeof err === "object") {
    const mongoErr = err as { code?: number; codeName?: string; message?: string };
    if (mongoErr.code === 40324) return true;
    const msg = mongoErr.message ?? "";
    if (msg.includes("index not found")) return true;
  }
  return false;
}

/**
 * Search locations. Phase 0F: runs a name/regex search against the static
 * seed list and a normalised-name lookup against `places.placesGeo` for
 * user-created entries. Atlas Search on `weather.locations` is gone.
 */
export async function searchLocationsFromDb(
  query: string,
  options: { tag?: string; limit?: number; skip?: number } = {},
): Promise<SearchResult> {
  const { tag, limit = 20, skip = 0 } = options;
  const q = query.trim();
  if (!q && !tag) return { locations: [], total: 0 };

  const lowered = q.toLowerCase();
  const seedMatches = LOCATIONS.filter((loc) => {
    if (tag && !loc.tags.includes(tag)) return false;
    if (!q) return true;
    return (
      loc.name.toLowerCase().includes(lowered) ||
      loc.slug.includes(lowered) ||
      loc.province.toLowerCase().includes(lowered)
    );
  });

  const total = seedMatches.length;
  const page = seedMatches.slice(skip, skip + limit);
  const now = new Date();
  return {
    locations: page.map((loc) => ({ ...loc, updatedAt: now })) as LocationDoc[],
    total,
  };
}

/**
 * Find nearest locations to coordinates via placesGeo.
 *
 * Phase 0F: delegates to `nearestPlacesGeo` from `places.ts`. Only returns
 * a single nearest result because that's all the previous callers (geo
 * lookup, dedup check) actually used.
 */
export async function findNearestLocationsFromDb(
  lat: number,
  lon: number,
  options: { limit?: number; maxDistanceKm?: number } = {},
): Promise<LocationDoc[]> {
  const { maxDistanceKm = 200 } = options;
  const doc = await nearestPlacesGeo(lat, lon, maxDistanceKm);
  if (!doc) return [];
  const adapted = await adaptPlacesGeoToLocationDoc(doc, {
    cleanSlug: doc.sourceProvenance?.mukokoSlug ?? doc.slug ?? "",
  });
  return [{ ...adapted, updatedAt: new Date() } as LocationDoc];
}

/** Tag counts derived from the static seed catalog. */
export async function getTagCounts(): Promise<{ tag: string; count: number }[]> {
  const counts = new Map<string, number>();
  for (const loc of LOCATIONS) {
    for (const tag of loc.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

/** Location + province counts derived from the static seed catalog. */
export async function getLocationStats(): Promise<{ locations: number; provinces: number }> {
  const provinces = new Set(LOCATIONS.map((l) => l.province));
  return { locations: LOCATIONS.length, provinces: provinces.size };
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

/** Track Atlas Search availability for activities (same pattern as locations). */
let atlasActivitySearchDisabledAt = 0;

/**
 * Search activities using Atlas Search (fuzzy) with $text fallback.
 * Requires an Atlas Search index named "activity_search" on the activities
 * collection. See getAtlasSearchIndexDefinitions() for the index spec.
 */
export async function searchActivitiesFromDb(
  query: string,
): Promise<ActivityDoc[]> {
  const q = query.trim();
  if (!q) return getAllActivitiesFromDb();

  // Try Atlas Search first (auto-recovers after ATLAS_RETRY_AFTER_MS)
  const activitySearchAvailable = !atlasActivitySearchDisabledAt || Date.now() - atlasActivitySearchDisabledAt > ATLAS_RETRY_AFTER_MS;
  if (activitySearchAvailable) {
    try {
      const col = activitiesCollection();
      const pipeline = [
        {
          $search: {
            index: "activity_search",
            text: {
              query: q,
              path: ["label", "description", "category"],
              fuzzy: { maxEdits: 1, prefixLength: 1 },
            },
          },
        },
        { $limit: 20 },
      ];
      return await col.aggregate<ActivityDoc>(pipeline).toArray();
    } catch (err) {
      if (isAtlasSearchIndexMissing(err)) {
        atlasActivitySearchDisabledAt = Date.now();
      }
    }
  }

  // Fallback: $text search
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
// Suitability rules operations
// ---------------------------------------------------------------------------

/**
 * Valid condition field names — must match keys of WeatherInsights.
 * Checked at seed/sync time to catch typos before they reach the database.
 */
export const VALID_CONDITION_FIELDS = new Set([
  "gdd10To30", "gdd10To31", "gdd08To30", "gdd03To25",
  "evapotranspiration", "dewPoint", "precipitationType",
  "windSpeed", "windGust",
  "thunderstormProbability", "heatStressIndex", "uvHealthConcern",
  "moonPhase", "cloudBase", "cloudCeiling", "visibility",
  // Future: precipitationIntensity, snowIntensity
]);

export async function syncSuitabilityRules(rules: Omit<SuitabilityRuleDoc, "updatedAt">[]): Promise<void> {
  // Validate condition field names at sync time to catch typos early.
  for (const rule of rules) {
    for (const cond of rule.conditions) {
      if (!VALID_CONDITION_FIELDS.has(cond.field)) {
        throw new Error(
          `Invalid condition field "${cond.field}" in rule "${rule.key}". ` +
          `Valid fields: ${[...VALID_CONDITION_FIELDS].join(", ")}`,
        );
      }
    }
  }

  const now = new Date();
  const bulkOps = rules.map((rule) => ({
    updateOne: {
      filter: { key: rule.key },
      update: { $set: { ...rule, updatedAt: now } },
      upsert: true,
    },
  }));
  if (bulkOps.length > 0) {
    await suitabilityRulesCollection().bulkWrite(bulkOps);
  }
}

export async function getAllSuitabilityRules(): Promise<SuitabilityRuleDoc[]> {
  return suitabilityRulesCollection().find({}).toArray();
}

export async function getSuitabilityRuleByKey(key: string): Promise<SuitabilityRuleDoc | null> {
  return suitabilityRulesCollection().findOne({ key });
}

// ---------------------------------------------------------------------------
// Activity category operations (database-driven category styles)
// ---------------------------------------------------------------------------

export async function syncActivityCategories(categories: ActivityCategoryDoc[]): Promise<void> {
  const now = new Date();
  const bulkOps = categories.map((cat) => ({
    updateOne: {
      filter: { id: cat.id },
      update: { $set: { ...cat, updatedAt: now } },
      upsert: true,
    },
  }));
  if (bulkOps.length > 0) {
    await activityCategoriesCollection().bulkWrite(bulkOps);
  }
}

export async function getAllActivityCategories(): Promise<ActivityCategoryDoc[]> {
  return activityCategoriesCollection().find({}).sort({ order: 1 }).toArray();
}

export async function getActivityCategoryById(id: string): Promise<ActivityCategoryDoc | null> {
  return activityCategoriesCollection().findOne({ id });
}

// ---------------------------------------------------------------------------
// Country operations
//
// Phase 0G: `weather.countries` is dropped. Country display/flag/region data
// comes from the static COUNTRIES array in `src/lib/countries.ts`; the
// canonical geographic hierarchy lives in `places.placesGeo` (Fundi-seeded).
// These readers keep their async signatures + CountryDoc return shape so every
// existing caller (`/explore/country`, breadcrumbs, `[location]/page.tsx`)
// works unchanged.
// ---------------------------------------------------------------------------

/**
 * Returns countries that have at least one location in the static seed
 * catalog. Phase 0F/0G: derives entirely from the static LOCATIONS +
 * COUNTRIES arrays (no weather-DB collection).
 */
export async function getAllCountries(): Promise<CountryDoc[]> {
  const seededCountries = new Set(
    LOCATIONS.map((l) => (l.country ?? "").toUpperCase()).filter(Boolean),
  );
  const now = new Date();
  return COUNTRIES.filter((c) => seededCountries.has(c.code.toUpperCase()))
    .sort((a, b) => a.region.localeCompare(b.region) || a.name.localeCompare(b.name))
    .map((c) => ({ ...c, updatedAt: now }));
}

export async function getCountryByCode(code: string): Promise<CountryDoc | null> {
  const upper = code.toUpperCase();
  const country = COUNTRIES.find((c) => c.code.toUpperCase() === upper);
  return country ? { ...country, updatedAt: new Date() } : null;
}

/** Get a country with the count of its locations (from the static seed catalog). */
export async function getCountryWithStats(
  code: string,
): Promise<(CountryDoc & { locationCount: number }) | null> {
  const country = await getCountryByCode(code);
  if (!country) return null;
  const upper = code.toUpperCase();
  const locationCount = LOCATIONS.filter(
    (l) => (l.country ?? "").toUpperCase() === upper,
  ).length;
  return { ...country, locationCount };
}

// ---------------------------------------------------------------------------
// Province operations
//
// Phase 0G: `weather.provinces` is dropped. Province display data comes from
// the static PROVINCES array in `src/lib/countries.ts`; the canonical
// geographic hierarchy lives in `places.placesGeo` (Fundi-seeded). Readers keep
// their async signatures + ProvinceDoc return shape for caller compatibility.
// ---------------------------------------------------------------------------

export async function getLocationsByCountry(countryCode: string): Promise<LocationDoc[]> {
  const now = new Date();
  const upper = countryCode.toUpperCase();
  return LOCATIONS.filter((l) => (l.country ?? "").toUpperCase() === upper)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((loc) => ({ ...loc, updatedAt: now })) as LocationDoc[];
}

export async function getLocationsByProvince(provinceSlug: string): Promise<LocationDoc[]> {
  const now = new Date();
  return LOCATIONS.filter((l) => {
    const slug = l.provinceSlug ?? generateProvinceSlug(l.province, l.country ?? "");
    return slug === provinceSlug;
  })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((loc) => ({ ...loc, updatedAt: now })) as LocationDoc[];
}

/**
 * Compute the province slug for a seed location: prefer its explicit
 * `provinceSlug`, otherwise derive it from the province name + country code.
 */
function provinceSlugForLocation(loc: WeatherLocation): string {
  return loc.provinceSlug ?? generateProvinceSlug(loc.province, loc.country ?? "");
}

/**
 * Get a single province by its slug. Prefers the static PROVINCES catalog (for
 * curated name/metadata) and falls back to DERIVING the province from the seed
 * LOCATIONS — so provinces that have seed locations but no static row (e.g.
 * Singapore's "Central Region") still resolve instead of dead-ending in a 404.
 */
export async function getProvinceBySlug(slug: string): Promise<ProvinceDoc | null> {
  const now = new Date();
  const province = PROVINCES.find((p) => p.slug === slug);
  if (province) return { ...province, updatedAt: now };

  const loc = LOCATIONS.find((l) => provinceSlugForLocation(l) === slug);
  if (!loc) return null;
  return {
    slug,
    name: loc.province,
    countryCode: (loc.country ?? "").toUpperCase(),
    updatedAt: now,
  };
}

/**
 * Get all provinces (for sitemap generation). UNIONs the static PROVINCES
 * catalog with provinces DERIVED from the seed LOCATIONS (static row wins on
 * name/metadata), so every province that has at least one location — including
 * countries with no static PROVINCES rows — is present in the sitemap.
 */
export async function getAllProvinces(): Promise<ProvinceDoc[]> {
  const now = new Date();
  const bySlug = new Map<string, ProvinceDoc>();

  for (const p of PROVINCES) {
    bySlug.set(p.slug, { ...p, updatedAt: now });
  }
  for (const loc of LOCATIONS) {
    const countryCode = (loc.country ?? "").toUpperCase();
    if (!countryCode) continue;
    const slug = provinceSlugForLocation(loc);
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { slug, name: loc.province, countryCode, updatedAt: now });
    }
  }

  return [...bySlug.values()].sort(
    (a, b) => a.countryCode.localeCompare(b.countryCode) || a.name.localeCompare(b.name),
  );
}

/**
 * Get all country codes that have at least one seed location (sitemap).
 * Derived from the static catalog now that weather.locations is dropped.
 */
export async function getAllCountryCodes(): Promise<string[]> {
  const codes = new Set<string>();
  for (const loc of LOCATIONS) {
    const c = (loc.country ?? "").toUpperCase();
    if (c) codes.add(c);
  }
  return [...codes];
}

/** All seed location slugs + tags for sitemap generation. */
export async function getAllLocationSlugsForSitemap(): Promise<{ slug: string; tags: string[] }[]> {
  return LOCATIONS.map((loc) => ({ slug: loc.slug, tags: loc.tags }));
}

/**
 * Get provinces for a country with their seed-location counts.
 *
 * Provinces are DERIVED from the actual seed LOCATIONS (grouped by
 * `provinceSlug ?? generateProvinceSlug(province, country)`) and UNIONed with
 * any static PROVINCES rows for the country. The static row wins for
 * name/metadata; derived groups fill the gaps for the ~41 countries that have
 * seed locations but no static PROVINCES entry (SG, DZ, MG, LY, SZ, …) and for
 * orphaned locations whose province slug has no matching static row. This
 * guarantees every location is reachable via exactly one province card with a
 * correct count. Static provinces with no seed locations are retained (count 0)
 * to preserve the previous browse behaviour.
 */
export async function getProvincesWithLocationCounts(
  countryCode: string,
): Promise<(ProvinceDoc & { locationCount: number })[]> {
  const upper = countryCode.toUpperCase();
  const now = new Date();

  const bySlug = new Map<string, ProvinceDoc & { locationCount: number }>();

  // Seed static rows first so their curated name/metadata win.
  for (const p of PROVINCES) {
    if (p.countryCode.toUpperCase() !== upper) continue;
    bySlug.set(p.slug, { ...p, updatedAt: now, locationCount: 0 });
  }

  // Derive from actual locations: fill gaps and count every location.
  for (const loc of LOCATIONS) {
    if ((loc.country ?? "").toUpperCase() !== upper) continue;
    const slug = provinceSlugForLocation(loc);
    const existing = bySlug.get(slug);
    if (existing) {
      existing.locationCount += 1;
    } else {
      bySlug.set(slug, {
        slug,
        name: loc.province,
        countryCode: upper,
        updatedAt: now,
        locationCount: 1,
      });
    }
  }

  return [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name));
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

/**
 * Region check — always returns true (app is fully global).
 *
 * Retained for backward compatibility with callers. No geographic
 * restrictions are enforced — any valid coordinates are accepted.
 */
export async function isInSupportedRegionFromDb(
  _lat: number, // eslint-disable-line @typescript-eslint/no-unused-vars
  _lon: number, // eslint-disable-line @typescript-eslint/no-unused-vars
): Promise<boolean> {
  return true;
}

/** No-op — retained for backward compatibility with tests. */
export function _clearRegionCache(): void {
  // No-op: region cache removed (app is fully global)
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

// ---------------------------------------------------------------------------
// Airport operations (aviation METAR/TAF nearest-station lookup)
// ---------------------------------------------------------------------------

/**
 * Seed the `weather.airports` collection from the static ICAO catalog
 * (`AIRPORTS` in `src/lib/icao-codes.ts`). Idempotent — upserts by ICAO code
 * (the document `_id`), so re-running never creates duplicates. Each doc carries
 * a GeoJSON `location` Point so the Python `$nearSphere` query can find the
 * nearest airports to a lat/lon.
 */
export async function syncAirports(
  airports: { icao: string; name: string; lat: number; lon: number }[],
): Promise<void> {
  const now = new Date();
  const bulkOps = airports.map((a) => {
    const icao = a.icao.toUpperCase();
    return {
      updateOne: {
        filter: { _id: icao },
        update: {
          $set: {
            icao,
            name: a.name,
            lat: a.lat,
            lon: a.lon,
            location: { type: "Point" as const, coordinates: [a.lon, a.lat] as [number, number] },
            updatedAt: now,
          },
        },
        upsert: true,
      },
    };
  });
  if (bulkOps.length > 0) {
    await airportsCollection().bulkWrite(bulkOps);
  }
}

export async function getTagBySlug(slug: string): Promise<TagDoc | null> {
  return tagsCollection().findOne({ slug });
}

export async function getFeaturedTagsFromDb(): Promise<TagDoc[]> {
  return tagsCollection().find({ featured: true }).sort({ order: 1 }).toArray();
}

// ---------------------------------------------------------------------------
// Season operations (replaces getDefaultSeason() hardcoded logic at runtime)
// ---------------------------------------------------------------------------

export async function syncSeasons(seasons: SeasonDoc[]): Promise<void> {
  // Migrate: rename old "shona" field to "localName" on any pre-existing docs
  await seasonsCollection().updateMany(
    { shona: { $exists: true }, localName: { $exists: false } },
    [{ $set: { localName: "$shona" } }, { $unset: "shona" }],
  );

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
 * Reads from the seasons collection; falls back to hemisphere-aware defaults if DB is unavailable.
 * Server-only — do not import in client components.
 */
export async function getSeasonForDate(
  date: Date = new Date(),
  countryCode: string = "",
  lat: number = 0,
): Promise<Season> {
  try {
    if (countryCode) {
      const doc = await getSeasonFromDb(date, countryCode);
      if (doc) {
        // Guard: old pre-migration docs may have "shona" instead of "localName"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const localName = doc.localName || (doc as any).shona as string || doc.name;
        return { name: doc.name, localName, description: doc.description };
      }
    }
  } catch {
    // DB unavailable — fall through to sync fallback
  }
  return getDefaultSeason(date, lat);
}

// ---------------------------------------------------------------------------
// Vector Search — semantic location queries for AI chat
// ---------------------------------------------------------------------------

/**
 * Search locations by semantic similarity using MongoDB Atlas Vector Search.
 * Locations must have an `embedding` field (float[] stored via storeLocationEmbedding).
 * Falls back to text search if the vector index is not configured.
 *
 * Requires an Atlas Vector Search index named "location_vector" on the
 * locations collection. See getAtlasSearchIndexDefinitions() for the spec.
 *
 * @param embedding - Pre-computed query embedding (e.g. from Anthropic or OpenAI)
 * @param options   - limit and optional tag filter
 */
/**
 * Vector search — Phase 0F: weather.locations is dropped, so this returns
 * an empty result. Semantic search will be reimplemented against
 * `shamwari.knowledgeBase` (vector-embedded) or `places.places` once an
 * embedding pipeline lands. Retained as a no-op so callers don't crash.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
export async function vectorSearchLocations(
  _embedding: number[],
  _options: { limit?: number; tag?: string } = {},
): Promise<LocationDoc[]> {
  return [];
}

/** No-op — see vectorSearchLocations. */
export async function storeLocationEmbedding(
  _slug: string,
  _embedding: number[],
): Promise<void> {
  /* no-op */
}

/** No-op — see vectorSearchLocations. */
export async function storeLocationEmbeddings(
  _entries: { slug: string; embedding: number[] }[],
): Promise<void> {
  /* no-op */
}
/* eslint-enable @typescript-eslint/no-unused-vars */

// ---------------------------------------------------------------------------
// Combined aggregation pipelines (batch multiple queries)
// ---------------------------------------------------------------------------

/**
 * Fetch tag counts and location stats in a single aggregation using $facet.
 * Replaces separate getTagCounts() + getLocationStats() calls.
 */
export async function getTagCountsAndStats(): Promise<{
  tags: { tag: string; count: number }[];
  totalLocations: number;
  totalProvinces: number;
}> {
  const tagMap = new Map<string, number>();
  const provinces = new Set<string>();
  for (const loc of LOCATIONS) {
    provinces.add(loc.province);
    for (const tag of loc.tags) {
      tagMap.set(tag, (tagMap.get(tag) ?? 0) + 1);
    }
  }
  return {
    tags: [...tagMap.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count),
    totalLocations: LOCATIONS.length,
    totalProvinces: provinces.size,
  };
}

// ---------------------------------------------------------------------------
// Atlas Search / Vector Search index definitions
// ---------------------------------------------------------------------------

/**
 * Returns the Atlas Search and Vector Search index definitions that should be
 * created via the MongoDB Atlas UI, Atlas CLI, or Atlas Admin API.
 *
 * These indexes CANNOT be created via the Node.js driver's createIndex() —
 * they must be provisioned through Atlas infrastructure.
 *
 * Usage:
 *   1. Go to Atlas → Database → Collections → Search Indexes
 *   2. Create each index using the JSON definitions below
 *   3. Or use Atlas CLI: `atlas clusters search indexes create --file <json>`
 */
export function getAtlasSearchIndexDefinitions(): {
  locationSearch: object;
  activitySearch: object;
  locationVector: object;
} {
  return {
    /** Atlas Search index for fuzzy location search */
    locationSearch: {
      name: "location_search",
      collectionName: "locations",
      type: "search",
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            name: [
              { type: "string", analyzer: "lucene.standard" },
              { type: "autocomplete", analyzer: "lucene.standard", tokenization: "edgeGram", minGrams: 2, maxGrams: 15 },
            ],
            province: { type: "string", analyzer: "lucene.standard" },
            slug: { type: "string", analyzer: "lucene.keyword" },
            tags: { type: "token" },
            country: { type: "token" },
          },
        },
      },
    },
    /** Atlas Search index for fuzzy activity search */
    activitySearch: {
      name: "activity_search",
      collectionName: "activities",
      type: "search",
      definition: {
        mappings: {
          dynamic: false,
          fields: {
            label: [
              { type: "string", analyzer: "lucene.standard" },
              { type: "autocomplete", analyzer: "lucene.standard", tokenization: "edgeGram", minGrams: 2, maxGrams: 15 },
            ],
            description: { type: "string", analyzer: "lucene.standard" },
            category: { type: "token" },
          },
        },
      },
    },
    /** Atlas Vector Search index for semantic location queries */
    locationVector: {
      name: "location_vector",
      collectionName: "locations",
      type: "vectorSearch",
      definition: {
        fields: [
          {
            type: "vector",
            path: "embedding",
            numDimensions: 1024,
            similarity: "cosine",
          },
          {
            type: "filter",
            path: "tags",
          },
          {
            type: "filter",
            path: "country",
          },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// AI Prompts — database-driven AI configuration
// ---------------------------------------------------------------------------

export async function syncAIPrompts(prompts: Omit<AIPromptDoc, "updatedAt">[]): Promise<void> {
  const now = new Date();
  const bulkOps = prompts.map((p) => ({
    updateOne: {
      filter: { promptKey: p.promptKey },
      update: { $set: { ...p, updatedAt: now } },
      upsert: true,
    },
  }));
  if (bulkOps.length > 0) {
    await aiPromptsCollection().bulkWrite(bulkOps);
  }
}

export async function syncAISuggestedRules(rules: Omit<AISuggestedPromptRule, "updatedAt">[]): Promise<void> {
  const now = new Date();
  const bulkOps = rules.map((r) => ({
    updateOne: {
      filter: { ruleId: r.ruleId },
      update: { $set: { ...r, updatedAt: now } },
      upsert: true,
    },
  }));
  if (bulkOps.length > 0) {
    await aiSuggestedRulesCollection().bulkWrite(bulkOps);
  }
}

/** Reset Atlas Search availability flags (for testing). */
export function _resetSearchFlags(): void {
  atlasActivitySearchDisabledAt = 0;
}

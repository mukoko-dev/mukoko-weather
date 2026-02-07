/**
 * Cloudflare KV caching layer for AI weather summaries.
 *
 * Tiered TTL strategy for 90+ locations:
 *
 * Tier 1 — Major cities (10 locations): 30-min TTL
 *   → 48 refreshes/day × 10 = 480 API calls/day
 *
 * Tier 2 — Active areas (farming, mining, education, border — ~50 locations): 60-min TTL
 *   → 24 refreshes/day × 50 = 1,200 API calls/day
 *   → Only generated on first user request (demand-driven)
 *
 * Tier 3 — Low-traffic (national parks, remote travel waypoints — ~30 locations): 120-min TTL
 *   → 12 refreshes/day × 30 = 360 API calls/day
 *   → Only generated on first user request (demand-driven)
 *
 * Maximum theoretical: ~2,040 Claude API calls/day
 * Practical (demand-driven): much lower since tier 2/3 only generate on access
 *
 * With 1M+ concurrent users, all users for the same location read from
 * the same cached entry — the cache is the scaling layer.
 */

export interface CachedAISummary {
  insight: string;
  generatedAt: string; // ISO timestamp
  locationSlug: string;
  weatherSnapshot: {
    temperature: number;
    weatherCode: number;
  };
}

// In-memory fallback for development / non-Cloudflare environments
const memoryCache = new Map<string, { value: string; expiresAt: number }>();

// Tier 1: Major cities — 30 min TTL
const TIER_1_SLUGS = new Set([
  "harare", "bulawayo", "mutare", "gweru", "masvingo",
  "kwekwe", "kadoma", "marondera", "chinhoyi", "victoria-falls",
]);

// Tier 2: Active areas — 60 min TTL
// Farming regions, mining areas, education centres, border posts, active cities
const TIER_2_TAGS = new Set(["farming", "mining", "education", "border"]);

const TTL_TIER_1 = 1800;  // 30 minutes
const TTL_TIER_2 = 3600;  // 60 minutes
const TTL_TIER_3 = 7200;  // 120 minutes

/**
 * Determine the TTL tier for a location based on its slug and tags.
 */
export function getTtlForLocation(
  locationSlug: string,
  tags: string[] = [],
): number {
  if (TIER_1_SLUGS.has(locationSlug)) {
    return TTL_TIER_1;
  }
  if (tags.some((t) => TIER_2_TAGS.has(t))) {
    return TTL_TIER_2;
  }
  return TTL_TIER_3;
}

/**
 * Get a cached AI summary from KV (or memory fallback).
 */
export async function getCachedSummary(
  locationSlug: string,
  kvNamespace?: KVNamespace,
): Promise<CachedAISummary | null> {
  const key = `ai-summary:${locationSlug}`;

  if (kvNamespace) {
    const raw = await kvNamespace.get(key);
    if (raw) {
      try {
        return JSON.parse(raw) as CachedAISummary;
      } catch {
        return null;
      }
    }
    return null;
  }

  // Memory fallback
  const entry = memoryCache.get(key);
  if (entry && entry.expiresAt > Date.now()) {
    try {
      return JSON.parse(entry.value) as CachedAISummary;
    } catch {
      return null;
    }
  }
  memoryCache.delete(key);
  return null;
}

/**
 * Store an AI summary in KV (or memory fallback).
 */
export async function setCachedSummary(
  locationSlug: string,
  summary: CachedAISummary,
  kvNamespace?: KVNamespace,
  ttlSeconds?: number,
): Promise<void> {
  const key = `ai-summary:${locationSlug}`;
  const value = JSON.stringify(summary);
  const ttl = ttlSeconds ?? TTL_TIER_2; // default to tier 2 if not specified

  if (kvNamespace) {
    await kvNamespace.put(key, value, { expirationTtl: ttl });
    return;
  }

  // Memory fallback
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttl * 1000,
  });
}

/**
 * Check if the cached summary is still relevant (weather hasn't changed dramatically).
 * If the temperature has shifted by more than 5°C or weather code changed, consider stale.
 */
export function isSummaryStale(
  cached: CachedAISummary,
  currentTemp: number,
  currentWeatherCode: number,
): boolean {
  const tempDelta = Math.abs(cached.weatherSnapshot.temperature - currentTemp);
  const codeChanged = cached.weatherSnapshot.weatherCode !== currentWeatherCode;
  return tempDelta > 5 || codeChanged;
}

/**
 * Cloudflare KV caching layer for AI weather summaries.
 *
 * Strategy:
 * - AI summaries are cached per location slug in KV
 * - Each cache entry has a TTL (default 30 minutes)
 * - On cache miss, generate a fresh AI summary and store it
 * - This means even with 1M users, we only call Claude API once per
 *   location per TTL window (10 locations × 48 refreshes/day = 480 API calls/day)
 *
 * In development (no KV binding), falls back to an in-memory Map.
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

const DEFAULT_TTL_SECONDS = 1800; // 30 minutes

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
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  const key = `ai-summary:${locationSlug}`;
  const value = JSON.stringify(summary);

  if (kvNamespace) {
    await kvNamespace.put(key, value, { expirationTtl: ttlSeconds });
    return;
  }

  // Memory fallback
  memoryCache.set(key, {
    value,
    expiresAt: Date.now() + ttlSeconds * 1000,
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

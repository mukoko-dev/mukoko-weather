import type { CachedWeatherHint } from "./types";

const KEY_PREFIX = "mukoko-weather-hint:";
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const MAX_ENTRIES = 50;

/**
 * Evict oldest weather hint entries when the cache exceeds MAX_ENTRIES.
 * Does a quick prefix-count first to avoid the expensive full parse/sort
 * scan on every write (eviction is rare with MAX_ENTRIES = 50).
 */
function evictOldest(): void {
  // Quick count of hint keys — skip the expensive full scan when under cap
  let hintCount = 0;
  for (let i = 0; i < localStorage.length; i++) {
    if (localStorage.key(i)?.startsWith(KEY_PREFIX)) hintCount++;
  }
  if (hintCount <= MAX_ENTRIES) return;

  // Over cap — snapshot all keys and parse timestamps for LRU eviction.
  // Snapshot first because iterating localStorage while removing shifts indices.
  const allKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k) allKeys.push(k);
  }

  const entries: { key: string; timestamp: number }[] = [];
  const corrupt: string[] = [];

  for (const key of allKeys) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      const hint: CachedWeatherHint = JSON.parse(raw);
      entries.push({ key, timestamp: hint.timestamp });
    } catch {
      corrupt.push(key);
    }
  }

  // Remove corrupt entries after iteration completes
  for (const key of corrupt) {
    localStorage.removeItem(key);
  }

  if (entries.length <= MAX_ENTRIES) return;

  // Sort oldest-first and remove excess
  entries.sort((a, b) => a.timestamp - b.timestamp);
  const toRemove = entries.length - MAX_ENTRIES;
  for (let i = 0; i < toRemove; i++) {
    localStorage.removeItem(entries[i].key);
  }
}

/**
 * Store a weather hint for a location in localStorage.
 * Used by WeatherDashboard to enable weather-aware loading scenes on return visits.
 * Caps storage at 50 entries (LRU eviction of oldest timestamps).
 */
export function cacheWeatherHint(slug: string, hint: CachedWeatherHint): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY_PREFIX + slug, JSON.stringify(hint));
    evictOldest();
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

/**
 * Read a cached weather hint for a location.
 * Returns null if no cache, expired (>2h), or localStorage unavailable.
 */
export function getCachedWeatherHint(slug: string): CachedWeatherHint | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(KEY_PREFIX + slug);
    if (!raw) return null;

    const hint = JSON.parse(raw);
    if (typeof hint !== "object" || hint === null || typeof hint.timestamp !== "number") {
      localStorage.removeItem(KEY_PREFIX + slug);
      return null;
    }
    if (Date.now() - hint.timestamp > MAX_AGE_MS) {
      localStorage.removeItem(KEY_PREFIX + slug);
      return null;
    }

    return hint as CachedWeatherHint;
  } catch {
    return null;
  }
}

import type { CachedWeatherHint } from "./types";
import { getCachedHint, cacheHint } from "../rxdb/collections";

const KEY_PREFIX = "mukoko-weather-hint:";
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// ---------------------------------------------------------------------------
// Synchronous localStorage fallback — needed for WeatherLoadingScene which
// reads hints synchronously during render. RxDB is async (IndexedDB), so we
// maintain localStorage as a fast synchronous read cache. RxDB is the source
// of truth; localStorage is a read-through cache populated on write.
// ---------------------------------------------------------------------------

/**
 * Store a weather hint for a location.
 * Writes to both RxDB (IndexedDB) and localStorage (sync fallback).
 */
export function cacheWeatherHint(slug: string, hint: CachedWeatherHint): void {
  // Sync write to localStorage for fast reads during loading scenes
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(KEY_PREFIX + slug, JSON.stringify(hint));
      evictOldest();
    } catch {
      // localStorage full or unavailable — silently ignore
    }
  }

  // Async write to RxDB (fire-and-forget)
  cacheHint(slug, {
    sceneType: "", // resolved by consumer
    weatherCode: hint.weatherCode,
    isDay: hint.isDay,
  }).catch(() => {
    // RxDB unavailable — localStorage fallback is sufficient
  });
}

/**
 * Read a cached weather hint for a location.
 * Reads from localStorage (synchronous) for immediate use in render.
 * Returns null if no cache, expired (>2h), or unavailable.
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

/**
 * Async version — reads from RxDB (IndexedDB).
 * Use when async access is acceptable (e.g., in useEffect).
 */
export async function getCachedWeatherHintAsync(slug: string): Promise<CachedWeatherHint | null> {
  // Try RxDB first
  const rxdbHint = await getCachedHint(slug);
  if (rxdbHint) {
    return {
      weatherCode: rxdbHint.weatherCode,
      isDay: rxdbHint.isDay,
      temperature: 0,
      windSpeed: 0,
      timestamp: rxdbHint.timestamp,
    };
  }

  // Fall back to localStorage
  return getCachedWeatherHint(slug);
}

// ---------------------------------------------------------------------------
// localStorage eviction (unchanged from original)
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 50;

function evictOldest(): void {
  let hintCount = 0;
  for (let i = 0; i < localStorage.length; i++) {
    if (localStorage.key(i)?.startsWith(KEY_PREFIX)) hintCount++;
  }
  if (hintCount <= MAX_ENTRIES) return;

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

  for (const key of corrupt) {
    localStorage.removeItem(key);
  }

  if (entries.length <= MAX_ENTRIES) return;

  entries.sort((a, b) => a.timestamp - b.timestamp);
  const toRemove = entries.length - MAX_ENTRIES;
  for (let i = 0; i < toRemove; i++) {
    localStorage.removeItem(entries[i].key);
  }
}

import type { CachedWeatherHint } from "./types";
import { cacheHint } from "../rxdb/collections";
import {
  listStorageKeys,
  parseStoredJSON,
  readStorage,
  readStorageJSON,
  removeStorage,
  writeStorageJSON,
} from "../safe-storage";

/** Sentinel for "absent or malformed" — distinct from any stored value. */
const MISSING = Symbol("missing");

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
  // Sync write to localStorage for fast reads during loading scenes.
  // A failed write (full / unavailable) is silently ignored.
  if (writeStorageJSON(KEY_PREFIX + slug, hint)) evictOldest();

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
  const key = KEY_PREFIX + slug;
  // Absent or malformed JSON is a plain miss — the entry is left in place.
  const hint = readStorageJSON<unknown>(key, MISSING);
  if (hint === MISSING) return null;

  if (
    typeof hint !== "object" ||
    hint === null ||
    typeof (hint as CachedWeatherHint).timestamp !== "number"
  ) {
    removeStorage(key);
    return null;
  }
  if (Date.now() - (hint as CachedWeatherHint).timestamp > MAX_AGE_MS) {
    removeStorage(key);
    return null;
  }

  return hint as CachedWeatherHint;
}

// ---------------------------------------------------------------------------
// localStorage eviction (unchanged from original)
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 50;

function evictOldest(): void {
  const allKeys = listStorageKeys();
  const hintKeys = allKeys.filter((k) => k.startsWith(KEY_PREFIX));
  if (hintKeys.length <= MAX_ENTRIES) return;

  const entries: { key: string; timestamp: number }[] = [];
  const corrupt: string[] = [];

  for (const key of hintKeys) {
    const raw = readStorage(key);
    if (!raw) continue;
    const hint = parseStoredJSON<CachedWeatherHint | null | typeof MISSING>(
      raw,
      MISSING,
    );
    if (hint === MISSING || hint === null) {
      corrupt.push(key);
      continue;
    }
    entries.push({ key, timestamp: hint.timestamp });
  }

  for (const key of corrupt) {
    removeStorage(key);
  }

  if (entries.length <= MAX_ENTRIES) return;

  entries.sort((a, b) => a.timestamp - b.timestamp);
  const toRemove = entries.length - MAX_ENTRIES;
  for (let i = 0; i < toRemove; i++) {
    removeStorage(entries[i].key);
  }
}

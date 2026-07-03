/**
 * Typed collection accessors for RxDB.
 *
 * Each function returns the collection (or null on server / if DB unavailable).
 * Consumers use these instead of accessing the raw database.
 */

import { getDatabase } from "./database";
import type { MukokoDatabase } from "./database";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function db(): Promise<MukokoDatabase | null> {
  return getDatabase();
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export async function preferencesCollection() {
  const d = await db();
  return d?.preferences ?? null;
}

// ---------------------------------------------------------------------------
// Weather cache
// ---------------------------------------------------------------------------

export async function weatherCacheCollection() {
  const d = await db();
  return d?.weather_cache ?? null;
}

/**
 * Get cached weather data for a location (returns null if expired or missing).
 */
export async function getCachedWeather(slug: string): Promise<{ data: string; provider: string } | null> {
  try {
    const col = await weatherCacheCollection();
    if (!col) return null;

    const doc = await col.findOne(slug).exec();
    if (!doc) return null;

    // Check TTL
    if (Date.now() > doc.expiresAt) {
      await doc.remove();
      return null;
    }

    return { data: doc.data, provider: doc.provider };
  } catch {
    // RxDB unavailable/errored — treat as cache miss.
    return null;
  }
}

/**
 * Store weather data for a location with a TTL.
 */
export async function cacheWeather(
  slug: string,
  data: string,
  provider: string,
  ttlMs: number = 15 * 60 * 1000,
): Promise<void> {
  try {
    const col = await weatherCacheCollection();
    if (!col) return;

    const now = Date.now();
    await col.upsert({
      slug,
      data,
      provider,
      cachedAt: now,
      expiresAt: now + ttlMs,
    });
  } catch {
    // RxDB unavailable/errored — caching is best-effort, never throw.
  }
}

// ---------------------------------------------------------------------------
// Weather hints
// ---------------------------------------------------------------------------

const HINT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
const HINT_MAX_ENTRIES = 50;

export async function weatherHintsCollection() {
  const d = await db();
  return d?.weather_hints ?? null;
}

/**
 * Get a cached weather hint for a location (null if expired/missing).
 */
export async function getCachedHint(slug: string) {
  try {
    const col = await weatherHintsCollection();
    if (!col) return null;

    const doc = await col.findOne(slug).exec();
    if (!doc) return null;

    if (Date.now() - doc.timestamp > HINT_MAX_AGE_MS) {
      await doc.remove();
      return null;
    }

    return { sceneType: doc.sceneType, weatherCode: doc.weatherCode, isDay: doc.isDay, timestamp: doc.timestamp };
  } catch {
    return null;
  }
}

/**
 * Store a weather hint, evicting oldest entries if over cap.
 */
export async function cacheHint(
  slug: string,
  hint: { sceneType: string; weatherCode: number; isDay: boolean },
): Promise<void> {
  try {
    const col = await weatherHintsCollection();
    if (!col) return;

    await col.upsert({
      slug,
      ...hint,
      timestamp: Date.now(),
    });

    // Evict oldest if over cap
    const allDocs = await col.find().exec();
    if (allDocs.length > HINT_MAX_ENTRIES) {
      const sorted = [...allDocs].sort((a, b) => a.timestamp - b.timestamp);
      const toRemove = sorted.slice(0, sorted.length - HINT_MAX_ENTRIES);
      for (const doc of toRemove) {
        await doc.remove();
      }
    }
  } catch {
    // best-effort — never throw from a hint write
  }
}

// ---------------------------------------------------------------------------
// Suitability rules
// ---------------------------------------------------------------------------

export async function suitabilityRulesCollection() {
  const d = await db();
  return d?.suitability_rules ?? null;
}

/**
 * Get all cached suitability rules. Returns empty array if none cached.
 */
export async function getCachedRules(): Promise<Array<{ key: string; conditions: string; fallback: string; updatedAt: number }>> {
  try {
    const col = await suitabilityRulesCollection();
    if (!col) return [];

    const docs = await col.find().exec();
    return docs.map((d) => ({ key: d.key, conditions: d.conditions, fallback: d.fallback, updatedAt: d.updatedAt }));
  } catch {
    return [];
  }
}

/**
 * Bulk upsert suitability rules into local cache.
 */
export async function cacheSuitabilityRules(
  rules: Array<{ key: string; conditions: string; fallback: string }>,
): Promise<void> {
  try {
    const col = await suitabilityRulesCollection();
    if (!col) return;

    const now = Date.now();
    for (const rule of rules) {
      await col.upsert({ ...rule, updatedAt: now });
    }
  } catch {
    // best-effort — never throw from a rules write
  }
}

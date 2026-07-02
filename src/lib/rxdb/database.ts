/**
 * RxDB database singleton — lazy-created, IndexedDB-backed.
 *
 * Returns null on server (no IndexedDB in Node). Uses Dexie storage adapter
 * (IndexedDB) which can be swapped to SQLite for Capacitor later.
 */

import { createRxDatabase, type RxDatabase } from "rxdb";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import {
  preferencesSchema,
  weatherCacheSchema,
  weatherHintSchema,
  suitabilityRuleSchema,
  type PreferencesDocType,
  type WeatherCacheDocType,
  type WeatherHintDocType,
  type SuitabilityRuleDocType,
} from "./schemas";

import type { RxCollection } from "rxdb";

// ---------------------------------------------------------------------------
// Collection type map
// ---------------------------------------------------------------------------

export type MukokoCollections = {
  preferences: RxCollection<PreferencesDocType>;
  weather_cache: RxCollection<WeatherCacheDocType>;
  weather_hints: RxCollection<WeatherHintDocType>;
  suitability_rules: RxCollection<SuitabilityRuleDocType>;
};

export type MukokoDatabase = RxDatabase<MukokoCollections>;

// ---------------------------------------------------------------------------
// Singleton
//
// RxDB is an OPTIONAL enhancement layer. It must NEVER crash the app — every
// failure mode (DB9 duplicate-database creation, schema-version conflict,
// StrictMode double-mount, IndexedDB unavailable in private browsing, etc.)
// resolves to `null` so callers seamlessly fall back to Zustand/localStorage.
//
// `getDatabase()` caches a single promise that resolves to `MukokoDatabase |
// null` and NEVER rejects — guaranteeing no unhandled rejection can bubble
// into React render.
// ---------------------------------------------------------------------------

let dbPromise: Promise<MukokoDatabase | null> | null = null;

/**
 * Get (or create) the RxDB database instance.
 * Returns null on the server, or whenever RxDB is unavailable/failed.
 * Idempotent + singleton — the underlying init runs at most once.
 */
export async function getDatabase(): Promise<MukokoDatabase | null> {
  if (typeof window === "undefined") return null;

  if (!dbPromise) {
    // createDbSafe never rejects, so the cached promise never rejects either.
    dbPromise = createDbSafe();
  }
  return dbPromise;
}

/** Wraps createDb so any failure resolves to null instead of throwing. */
async function createDbSafe(): Promise<MukokoDatabase | null> {
  try {
    return await createDb();
  } catch (err: unknown) {
    // App still works; preferences fall back to Zustand + localStorage.
    console.warn(
      "[RxDB] Failed to initialise database, using in-memory/localStorage fallback:",
      String(err),
    );
    return null;
  }
}

async function createDb(): Promise<MukokoDatabase> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await _initDb();
    } catch (err: unknown) {
      const msg = String(err);
      // DB9 = "database created twice with the same name" / schema-version
      // conflict — common under React StrictMode double-mount or a stale
      // IndexedDB from a previous schema version. Wipe + retry once.
      const isDB9 = msg.includes("DB9");
      if (isDB9 && attempt === 0) {
        await wipeIndexedDb("mukoko_weather");
        continue;
      }
      // Give up gracefully — createDbSafe swallows this and returns null.
      throw err;
    }
  }
  throw new Error("[RxDB] unreachable init state");
}

/** Best-effort native IndexedDB delete — never throws, always resolves. */
async function wipeIndexedDb(name: string): Promise<void> {
  try {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  } catch {
    // indexedDB itself unavailable — nothing to wipe.
  }
}

async function _initDb(): Promise<MukokoDatabase> {
  const db = await createRxDatabase<MukokoCollections>({
    name: "mukoko_weather",
    storage: getRxStorageDexie(),
    multiInstance: false, // single-tab app — avoids DB9 leader-election conflicts
    ignoreDuplicate: true, // singleton guard — swallow "duplicate DB" (DB9) races
  });

  await db.addCollections({
    preferences: {
      schema: preferencesSchema,
      // v0 → v1: added `selectedForecastModel` (Windy-style model preference).
      migrationStrategies: {
        1: (oldDoc: PreferencesDocType) => ({
          ...oldDoc,
          selectedForecastModel: oldDoc.selectedForecastModel ?? "best_match",
        }),
      },
    },
    weather_cache: { schema: weatherCacheSchema },
    weather_hints: { schema: weatherHintSchema },
    suitability_rules: { schema: suitabilityRuleSchema },
  });

  return db;
}

/**
 * Destroy the database (for testing / cleanup). Never throws.
 */
export async function destroyDatabase(): Promise<void> {
  if (!dbPromise) return;
  try {
    const db = await dbPromise;
    if (db) await db.close();
  } catch {
    // ignore — best-effort teardown
  } finally {
    dbPromise = null;
  }
}

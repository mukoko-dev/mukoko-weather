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
// ---------------------------------------------------------------------------

let dbPromise: Promise<MukokoDatabase> | null = null;

/**
 * Get (or create) the RxDB database instance.
 * Returns null on server — caller must guard.
 */
export async function getDatabase(): Promise<MukokoDatabase | null> {
  if (typeof window === "undefined") return null;

  if (!dbPromise) {
    dbPromise = createDb();
  }
  return dbPromise;
}

async function createDb(): Promise<MukokoDatabase> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await _initDb();
    } catch (err: unknown) {
      const msg = String(err);
      const isDB9 = msg.includes("DB9");
      if (isDB9 && attempt === 0) {
        // DB9: stale v16 database or multiInstance conflict.
        // Wipe via native IndexedDB then retry once.
        await new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase("mukoko_weather");
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        });
        dbPromise = null;
        continue;
      }
      // On second attempt or non-DB9 error — give up gracefully.
      // App still works; preferences just won't persist via RxDB.
      console.warn("[RxDB] Failed to initialise database, using in-memory fallback:", msg);
      throw err;
    }
  }
  throw new Error("unreachable");
}

async function _initDb(): Promise<MukokoDatabase> {
  const db = await createRxDatabase<MukokoCollections>({
    name: "mukoko_weather",
    storage: getRxStorageDexie(),
    multiInstance: false, // single-tab app — avoids DB9 leader-election conflicts
    ignoreDuplicate: true,
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
 * Destroy the database (for testing / cleanup).
 */
export async function destroyDatabase(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    await db.close();
    dbPromise = null;
  }
}

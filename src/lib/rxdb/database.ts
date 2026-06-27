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
  try {
    return await _initDb();
  } catch (err: unknown) {
    // RxDB DB9: storageToken mismatch — happens after a major RxDB upgrade
    // (v16→v17 changed internal metadata). Wipe the stale IndexedDB and retry.
    const code = (err as { code?: string })?.code;
    const msg = String(err);
    if (code === "DB9" || msg.includes("DB9") || msg.includes("storageToken")) {
      try {
        const { deleteRxDatabase } = await import("rxdb");
        await deleteRxDatabase("mukoko_weather", getRxStorageDexie());
      } catch {
        // Best-effort cleanup — ignore if deletion fails
      }
      dbPromise = null;
      return await _initDb();
    }
    throw err;
  }
}

async function _initDb(): Promise<MukokoDatabase> {
  const db = await createRxDatabase<MukokoCollections>({
    name: "mukoko_weather",
    storage: getRxStorageDexie(),
    multiInstance: true,
    ignoreDuplicate: true,
  });

  await db.addCollections({
    preferences: { schema: preferencesSchema },
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

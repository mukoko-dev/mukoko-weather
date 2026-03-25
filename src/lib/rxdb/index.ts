/**
 * RxDB local-first storage — barrel export.
 *
 * Usage:
 *   import { getDatabase, getCachedWeather, cacheWeather } from "@/lib/rxdb";
 */

// Database
export { getDatabase, destroyDatabase, type MukokoDatabase, type MukokoCollections } from "./database";

// Schemas
export type {
  PreferencesDocType,
  WeatherCacheDocType,
  WeatherHintDocType,
  SuitabilityRuleDocType,
} from "./schemas";

// Collections + helpers
export {
  preferencesCollection,
  weatherCacheCollection,
  getCachedWeather,
  cacheWeather,
  weatherHintsCollection,
  getCachedHint,
  cacheHint,
  suitabilityRulesCollection,
  getCachedRules,
  cacheSuitabilityRules,
} from "./collections";

// Bridge (Zustand ↔ RxDB)
export { initRxDBBridge, migrateLocalStorageToRxDB } from "./bridge";

// Replication
export { startReplication, stopReplication } from "./replication";

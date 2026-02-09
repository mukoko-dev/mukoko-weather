/**
 * @deprecated — Replaced by MongoDB Atlas (src/lib/db.ts).
 * This file is kept temporarily for reference during migration.
 * All caching now uses MongoDB collections with TTL indexes.
 *
 * Migration mapping:
 *   KV AI_SUMMARIES    → MongoDB "ai_summaries" collection
 *   KV WEATHER_CACHE   → MongoDB "weather_cache" collection
 *   In-memory fallback → Removed (MongoDB handles all environments)
 */

export type { CachedAISummary } from "./db";
export { getCachedAISummary, isSummaryStale, getTtlForLocation } from "./db";

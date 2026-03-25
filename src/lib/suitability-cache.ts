/**
 * Client-side cache for suitability rules and category styles.
 *
 * Backed by RxDB (IndexedDB) for offline persistence.
 * In-memory layer with TTL for fast synchronous access.
 *
 * Extracted from ActivityInsights.tsx so that:
 *   - Cache state is separate from component rendering logic
 *   - Tests can call resetCaches() for clean isolation
 *   - HMR in development only refreshes the component, not the cache module
 */

import { CATEGORY_STYLES } from "./activities";
import type { SuitabilityRuleDoc, ActivityCategoryDoc } from "./db";
import { getCachedRules, cacheSuitabilityRules } from "./rxdb/collections";

// ---------------------------------------------------------------------------
// Suitability rules cache
// ---------------------------------------------------------------------------

let cachedRules: SuitabilityRuleDoc[] | null = null;
let cachedRulesAt = 0;
// Shared TTL for both rules and category styles — both change only on deployment
// (via db-init), so a single 10-minute TTL is appropriate for both.
const RULES_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// In-flight promise guards — prevent parallel callers from issuing duplicate
// requests when the cache is cold (e.g. multiple ActivityCards mounting at once).
let inFlightRules: Promise<SuitabilityRuleDoc[]> | null = null;

export async function fetchSuitabilityRules(): Promise<SuitabilityRuleDoc[]> {
  if (cachedRules && Date.now() - cachedRulesAt < RULES_CACHE_TTL) {
    return cachedRules;
  }
  if (inFlightRules) return inFlightRules;

  inFlightRules = (async () => {
    // Try RxDB first (offline-capable)
    const localRules = await getCachedRules();
    if (localRules.length > 0) {
      const parsed = localRules.map((r) => {
        try {
          return { key: r.key, conditions: JSON.parse(r.conditions) };
        } catch {
          return null;
        }
      }).filter(Boolean) as SuitabilityRuleDoc[];

      if (parsed.length > 0) {
        cachedRules = parsed;
        cachedRulesAt = Date.now();
      }
    }

    // Only fetch from network if the cache is stale or empty.
    // Without this guard, every call would issue a network request even
    // when RxDB just returned fresh data — defeating the TTL purpose.
    const cacheIsWarm = cachedRules && cachedRules.length > 0 && Date.now() - cachedRulesAt < RULES_CACHE_TTL;
    if (!cacheIsWarm) {
      try {
        const res = await fetch("/api/py/suitability");
        if (res.ok) {
          const data = await res.json();
          const rules = data?.rules;
          if (rules && rules.length > 0) {
            cachedRules = rules;
            cachedRulesAt = Date.now();

            // Persist to RxDB for offline access (fire-and-forget)
            cacheSuitabilityRules(
              rules.map((r: SuitabilityRuleDoc) => ({
                key: r.key,
                conditions: JSON.stringify(r.conditions),
              })),
            ).catch(() => {});
          }
        }
      } catch {
        // Network error — use whatever we got from RxDB
      }
    }

    return cachedRules ?? [];
  })();

  try {
    return await inFlightRules;
  } finally {
    inFlightRules = null;
  }
}

// ---------------------------------------------------------------------------
// Category styles cache
// ---------------------------------------------------------------------------

// Seed with static CATEGORY_STYLES for instant mineral color rendering on mount.
// The API fetch upgrades this with any MongoDB-only categories.
let cachedCategoryStyles: Record<string, { bg: string; border: string; text: string; badge: string }> = { ...CATEGORY_STYLES };
let cachedStylesAt = 0;

export type CategoryStyle = { bg: string; border: string; borderAccent?: string; text: string; badge: string };

let inFlightStyles: Promise<Record<string, CategoryStyle>> | null = null;

export async function fetchCategoryStyles(): Promise<Record<string, CategoryStyle>> {
  if (cachedStylesAt > 0 && Date.now() - cachedStylesAt < RULES_CACHE_TTL) {
    return cachedCategoryStyles;
  }
  if (inFlightStyles) return inFlightStyles;
  inFlightStyles = fetch("/api/py/activities?mode=categories")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const styles: Record<string, CategoryStyle> = {};
      for (const cat of (data?.categories ?? []) as ActivityCategoryDoc[]) {
        if (cat.style) styles[cat.id] = cat.style;
      }
      if (Object.keys(styles).length > 0) {
        cachedCategoryStyles = styles;
        cachedStylesAt = Date.now(); // only cache TTL when we got real data
      }
      return cachedCategoryStyles;
    })
    .catch(() => cachedCategoryStyles)
    .finally(() => { inFlightStyles = null; });
  return inFlightStyles;
}

// ---------------------------------------------------------------------------
// Test helpers — reset caches for clean test isolation
// ---------------------------------------------------------------------------

export function resetCaches(): void {
  cachedRules = null;
  cachedRulesAt = 0;
  cachedCategoryStyles = { ...CATEGORY_STYLES };
  cachedStylesAt = 0;
  inFlightRules = null;
  inFlightStyles = null;
}

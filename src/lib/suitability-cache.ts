/**
 * Client-side cache for suitability rules and category styles.
 *
 * Extracted from ActivityInsights.tsx so that:
 *   - Cache state is separate from component rendering logic
 *   - Tests can call resetCaches() for clean isolation
 *   - HMR in development only refreshes the component, not the cache module
 */

import { CATEGORY_STYLES } from "./activities";
import type { SuitabilityRuleDoc, ActivityCategoryDoc } from "./db";

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
  inFlightRules = fetch("/api/suitability")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      const rules = data?.rules;
      if (rules && rules.length > 0) {
        cachedRules = rules;
        cachedRulesAt = Date.now(); // only cache TTL when we got real data
      }
      return cachedRules ?? [];
    })
    .catch(() => cachedRules ?? [])
    .finally(() => { inFlightRules = null; });
  return inFlightRules;
}

// ---------------------------------------------------------------------------
// Category styles cache
// ---------------------------------------------------------------------------

// Seed with static CATEGORY_STYLES for instant mineral color rendering on mount.
// The API fetch upgrades this with any MongoDB-only categories.
let cachedCategoryStyles: Record<string, { bg: string; border: string; text: string; badge: string }> = { ...CATEGORY_STYLES };
let cachedStylesAt = 0;

export type CategoryStyle = { bg: string; border: string; text: string; badge: string };

let inFlightStyles: Promise<Record<string, CategoryStyle>> | null = null;

export async function fetchCategoryStyles(): Promise<Record<string, CategoryStyle>> {
  if (cachedStylesAt > 0 && Date.now() - cachedStylesAt < RULES_CACHE_TTL) {
    return cachedCategoryStyles;
  }
  if (inFlightStyles) return inFlightStyles;
  inFlightStyles = fetch("/api/activities?mode=categories")
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

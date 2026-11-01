/**
 * Feature Flags — lightweight, type-safe, client-side feature flag system.
 *
 * Flags are code-defined with optional localStorage overrides for dev/staging.
 * No SaaS dependency — flags can be extended to MongoDB-backed in the future.
 *
 * Usage:
 *   import { getFeatureFlag, isFeatureEnabled } from "@/lib/feature-flags";
 *
 *   // In components or anywhere (checks localStorage overrides)
 *   const enabled = getFeatureFlag("weather_reports");
 *
 *   // Without localStorage overrides (safe on server)
 *   if (isFeatureEnabled("premium_maps")) { ... }
 *
 * Dev overrides via localStorage (browser console):
 *   localStorage.setItem("ff:premium_maps", "true")   // enable
 *   localStorage.setItem("ff:premium_maps", "false")   // disable
 *   localStorage.removeItem("ff:premium_maps")          // revert to default
 */

import { readStorage } from "./safe-storage";

// ── Flag definitions ────────────────────────────────────────────────────────

/**
 * Default flag values. All currently-shipped features start as `true`.
 * New/experimental features start as `false` and are enabled via deploy config
 * or localStorage override during testing.
 */
export const FLAGS = {
  /** Community weather reporting (Waze-style) */
  weather_reports: true,
  /** Inline AI follow-up chat on location pages */
  ai_summary_chat: true,
  /** AI-powered explore search */
  explore_search: true,
  /** Historical weather AI analysis */
  history_analysis: true,
  /**
   * Full-viewport Shamwari AI chat as a standalone destination page.
   * Disabled — a dedicated chatbot destination in primary nav doesn't match
   * how weather apps work (users open a weather app to see the weather, not
   * to choose between weather and a chat page). AI stays available as an
   * ambient enhancement (inline AI summaries, AI-powered explore search)
   * rather than a first-class nav destination. `/shamwari` 404s while this
   * is false; flip to `true` to bring it back as a reachable page.
   */
  shamwari_chat: false,
  /** Interactive weather map layers */
  map_layers: true,
  /** Premium map layers (radar, satellite) — requires subscription */
  premium_maps: false,
  /**
   * Per-model forecast fields on the map (ECMWF IFS/AIFS, GFS, ICON, GEM,
   * ARPEGE via the Worker (/v1/model-grid)). Off until the owner settles Open-Meteo's
   * commercial terms — its free API is non-commercial. Try it locally with
   * localStorage.setItem("ff:model_map_layers", "true").
   */
  model_map_layers: false,
  /**
   * Apple Weather (WeatherKit) as a forecast model: a pick in My Weather and
   * a series in the model comparison. OFF until two things are true: the
   * Servers API origin (Gwaihir) serves `apple_weatherkit` (a picker entry
   * that does nothing would be a lie), and the owner has confirmed that the
   * Apple Developer Program terms allow the 15-minute cache and the blended
   * use. It also needs Apple's official mark (`forecast-sources.ts`
   * `markAssetUrl`); a test refuses the flag on without it. Try it locally
   * with localStorage.setItem("ff:apple_weatherkit", "true").
   */
  apple_weatherkit: false,
  /** Vector semantic search for locations */
  vector_search: false,
  /** Multi-language support (Shona, Ndebele) */
  multi_language: false,
} as const;

export type FeatureFlag = keyof typeof FLAGS;

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if a feature flag is enabled.
 * Uses default flag values — does NOT check localStorage overrides.
 * Safe to call on server or client.
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return FLAGS[flag] ?? false;
}

/**
 * Check if a feature flag is enabled, with localStorage override support.
 * Checks `localStorage.getItem("ff:<flag>")` first, then falls back to
 * the default flag value.
 *
 * Only checks localStorage on the client (no-ops to default on server).
 */
export function isFeatureEnabledWithOverride(flag: FeatureFlag): boolean {
  // readStorage is SSR-safe and returns null when storage is unavailable
  // (private browsing, blocked) — the default applies in that case.
  const override = readStorage(`ff:${flag}`);
  if (override === "true") return true;
  if (override === "false") return false;
  return FLAGS[flag] ?? false;
}

/**
 * Check a feature flag with localStorage override support.
 * Alias for `isFeatureEnabledWithOverride` with a shorter name.
 *
 * Safe to call anywhere (components, utilities, event handlers).
 * Synchronous read — flag changes require a page reload to take effect.
 */
export function getFeatureFlag(flag: FeatureFlag): boolean {
  return isFeatureEnabledWithOverride(flag);
}

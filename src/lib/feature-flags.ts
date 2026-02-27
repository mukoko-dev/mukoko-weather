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
  /** Full-viewport Shamwari AI chat */
  shamwari_chat: true,
  /** Interactive weather map layers */
  map_layers: true,
  /** Premium map layers (radar, satellite) — requires subscription */
  premium_maps: false,
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
  if (typeof window !== "undefined") {
    try {
      const override = localStorage.getItem(`ff:${flag}`);
      if (override === "true") return true;
      if (override === "false") return false;
    } catch {
      // localStorage unavailable (private browsing, quota exceeded) — use default
    }
  }
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

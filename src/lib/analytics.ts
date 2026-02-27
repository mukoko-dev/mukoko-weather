/**
 * Analytics — centralized event tracking for GA4 and Vercel Analytics.
 *
 * Fires every event to both Google Analytics 4 (via gtag) and Vercel Analytics
 * (via @vercel/analytics track()). No-ops silently on the server or if the
 * analytics scripts haven't loaded yet.
 *
 * Usage:
 *   import { trackEvent } from "@/lib/analytics";
 *   trackEvent("report_submitted", { type: "heavy-rain", severity: "moderate", location: "harare" });
 *
 * Privacy: Only action names and non-PII metadata (location slugs, activity IDs,
 * theme preferences) are tracked. No personally identifiable information is collected.
 */

import { track } from "@vercel/analytics";

// ── Type-safe event definitions ─────────────────────────────────────────────

export type AnalyticsEvents = {
  /** Community weather report submitted (3-step wizard complete) */
  report_submitted: { type: string; severity: string; location: string };
  /** Community weather report upvoted */
  report_upvoted: { reportId: string; location: string };
  /** User changed their current location */
  location_changed: {
    from: string;
    to: string;
    method: "search" | "geolocation" | "saved";
  };
  /** User saved a location to their list */
  location_saved: { slug: string };
  /** User removed a location from their list */
  location_removed: { slug: string };
  /** User toggled an activity on/off */
  activity_toggled: { activityId: string; enabled: boolean };
  /** User changed their theme preference */
  theme_changed: { theme: "light" | "dark" | "system" };
  /** AI weather summary loaded for a location */
  ai_summary_loaded: { location: string };
  /** User sent a message in AI chat (inline follow-up or Shamwari) */
  ai_chat_sent: { source: "inline" | "shamwari"; location?: string };
  /** User performed an explore search */
  explore_search: { query: string; resultCount: number };
  /** User triggered historical weather analysis */
  history_analysis: { location: string; days: number };
  /** Geolocation detection completed */
  geolocation_result: { status: string; location?: string };
  /** User changed the weather map layer */
  map_layer_changed: { layer: string; location: string };
  /** User completed the onboarding welcome banner */
  onboarding_completed: { method: "personalize" | "continue" };
  /** User opened a modal */
  modal_opened: {
    modal: "my-weather" | "saved-locations" | "weather-report";
  };
};

// ── Core tracking function ──────────────────────────────────────────────────

/**
 * Track a user interaction event to both GA4 and Vercel Analytics.
 *
 * - No-ops on the server (typeof window === "undefined")
 * - Silently swallows errors so tracking never breaks the app
 * - GA4: fires via window.gtag("event", name, properties)
 * - Vercel: fires via track(name, properties)
 */
export function trackEvent<K extends keyof AnalyticsEvents>(
  name: K,
  properties: AnalyticsEvents[K],
): void {
  if (typeof window === "undefined") return;

  // Vercel Analytics — track() is safe to call even if the script hasn't loaded
  try {
    track(
      name,
      properties as Record<string, string | number | boolean | null>,
    );
  } catch {
    // Silent — tracking should never break the app
  }

  // Google Analytics 4 — gtag may not be loaded yet (ad blockers, slow network)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gtag = (window as any).gtag as
    | ((...args: unknown[]) => void)
    | undefined;

  if (typeof gtag === "function") {
    gtag("event", name, properties);
  }
}

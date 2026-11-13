/**
 * How fast the app really opens, for the people who really open it (#551).
 *
 * The five numbers a visitor on a slow phone lives through, taken from the
 * browser's own timings: FCP (first paint), LCP (the main content), INP (how
 * fast a tap is answered), CLS (a layout that jumps) and TTFB (the wait for the
 * server). Each goes to GA4 as one `web_vitals` event; GA4 is the app's only
 * analytics.
 *
 * Privacy: a number, its rating, how the page was opened, a coarse route
 * (`home`, `place` or `other`, never the place's name) and the connection class
 * the browser reports (`4g`, `3g`, ...). No id, no URL, no location, nothing
 * that tells one visitor from another. The pure parts live here so a test can
 * pin that; `components/analytics/WebVitals.tsx` only wires them to the browser.
 */
import type { Gtag } from "@/lib/ga-page-view";
import { isPlacePath } from "@/lib/sw-navigation";

/** The only metrics reported; Next also emits hydration and render timings. */
export const REPORTED_VITALS = ["FCP", "LCP", "INP", "CLS", "TTFB"] as const;
export type ReportedVital = (typeof REPORTED_VITALS)[number];

export type VitalRating = "good" | "needs-improvement" | "poor" | "unknown";
export type VitalRoute = "home" | "place" | "other";

/** The slice of a web-vitals metric this uses. */
export interface VitalMetric {
  name: string;
  value: number;
  rating?: string;
  navigationType?: string;
}

/** What GA4 receives. Every field is a short fixed word or a rounded number. */
export interface WebVitalEvent {
  metric_name: ReportedVital;
  /** Milliseconds, rounded. CLS has no unit, so it is sent times 1000. */
  metric_value: number;
  metric_rating: VitalRating;
  navigation_type: string;
  route: VitalRoute;
  connection: string;
}

const RATINGS: ReadonlySet<string> = new Set([
  "good",
  "needs-improvement",
  "poor",
]);
const NAVIGATIONS: ReadonlySet<string> = new Set([
  "navigate",
  "reload",
  "back-forward",
  "back-forward-cache",
  "prerender",
  "restore",
]);
const CONNECTIONS: ReadonlySet<string> = new Set(["slow-2g", "2g", "3g", "4g"]);

/** `/` is home, `/{slug}` is a place, everything else is one bucket. */
export function routeOf(pathname: string): VitalRoute {
  if (pathname === "/") return "home";
  return isPlacePath(pathname) ? "place" : "other";
}

/**
 * The event for one metric, or null when it is not one of the five or its
 * value is unusable. `connection` is `navigator.connection.effectiveType`.
 */
export function toVitalEvent(
  metric: VitalMetric,
  pathname: string,
  connection?: string,
): WebVitalEvent | null {
  const name = (REPORTED_VITALS as readonly string[]).includes(metric.name)
    ? (metric.name as ReportedVital)
    : null;
  if (!name) return null;
  if (!Number.isFinite(metric.value) || metric.value < 0) return null;
  return {
    metric_name: name,
    metric_value: Math.round(
      name === "CLS" ? metric.value * 1000 : metric.value,
    ),
    metric_rating:
      metric.rating && RATINGS.has(metric.rating)
        ? (metric.rating as VitalRating)
        : "unknown",
    navigation_type:
      metric.navigationType && NAVIGATIONS.has(metric.navigationType)
        ? metric.navigationType
        : "unknown",
    route: routeOf(pathname),
    connection:
      connection && CONNECTIONS.has(connection) ? connection : "unknown",
  };
}

/** gtag.js loads after the page is interactive, so first paint can beat it. */
export const GTAG_WAIT_MS = 250;
export const GTAG_MAX_TRIES = 40;

export interface VitalWindow {
  gtag?: Gtag;
}

/**
 * Sends the event once `gtag` exists, waiting up to ten seconds for it (an ad
 * blocker means it never does, and the event is dropped). Never throws.
 */
export function sendVital(
  event: WebVitalEvent,
  win: VitalWindow,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  tries = 0,
): void {
  try {
    if (typeof win.gtag === "function") {
      win.gtag("event", "web_vitals", event);
      return;
    }
    if (tries >= GTAG_MAX_TRIES) return;
    schedule(() => sendVital(event, win, schedule, tries + 1), GTAG_WAIT_MS);
  } catch {
    // Measuring must never break the app.
  }
}

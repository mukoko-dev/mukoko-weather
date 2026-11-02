/**
 * Community weather reports as the app asks for them: `POST` and `GET
 * /v1/reports` and `POST /v1/reports/upvote` on the Rust Worker (`workers/places`
 * behind `mukoko-weather-api`, MongoDB through the bridge). The report lane, the
 * recent-reports card and the report wizard share these URLs and the one rule
 * for reading a refusal.
 *
 * (The wizard's follow-up questions, `POST /reports/clarify`, are the AI
 * Worker's and not served here yet.)
 *
 * Pure helpers, no I/O. Edge-safe.
 */
import { workerUrl } from "@/lib/weather-api";
import { workerData } from "@/lib/worker-data";

/** How far back the lane and the card list reports, in hours. */
export const REPORT_WINDOW_HOURS = 24;

/** `GET /v1/reports?location=<slug>&hours=<n>` */
export function reportsListUrl(
  slug: string,
  hours: number = REPORT_WINDOW_HOURS,
): string {
  return workerUrl(
    "reports",
    `location=${encodeURIComponent(slug)}&hours=${hours}`,
  );
}

/**
 * The recent reports for a place, through the shared store: the report lane
 * and the recent-reports card mount together and ask for the same list, so it
 * is one call, and a remount or a swipe back within a minute is free. Rejects
 * on a refusal (callers show an empty list).
 */
export function loadReports<T>(
  slug: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ reports?: T[] }> {
  return workerData.json<{ reports?: T[] }>(
    "reports",
    { location: slug, hours: REPORT_WINDOW_HOURS },
    options,
  );
}

/** Drop the kept list for a place (after the visitor submits a report). */
export function forgetReports(slug: string): void {
  workerData.invalidate("reports", {
    location: slug,
    hours: REPORT_WINDOW_HOURS,
  });
}

/** `POST /v1/reports` */
export function reportsSubmitUrl(): string {
  return workerUrl("reports", "");
}

/** `POST /v1/reports/upvote` */
export function reportsUpvoteUrl(): string {
  return workerUrl("reports/upvote", "");
}

/**
 * The words to show for a refused request: the Worker's
 * `error_description`, else FastAPI's `detail` (the follow-up questions route
 * is still Python), else the fallback.
 */
export function reportRefusal(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const b = body as { error_description?: unknown; detail?: unknown };
  for (const text of [b.error_description, b.detail]) {
    if (typeof text === "string" && text.trim()) return text;
  }
  return fallback;
}

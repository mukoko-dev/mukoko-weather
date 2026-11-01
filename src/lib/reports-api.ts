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

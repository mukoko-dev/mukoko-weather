/**
 * Community weather reports as the app asks for them: `POST` and `GET
 * /v1/reports` and `POST /v1/reports/upvote` on the Rust Worker (`workers/places`
 * behind `mukoko-weather-api`, MongoDB through the bridge), and the wizard's
 * follow-up questions, `POST /v1/reports/clarify` (the AI Worker behind the
 * same API; it answers a fixed pair of questions whenever the model cannot).
 * The report lane, the recent-reports card and the report wizard share these
 * URLs and the one rule for reading a refusal.
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
 * How long the wizard waits for its follow-up questions. The Worker answers
 * within about 13 seconds whatever happens (the model is given 8, the rest is
 * the guardrails block and the budget); past this the wizard carries on
 * without questions. `POST /v1/reports/clarify` `{locationSlug, reportType}`
 * -> `{questions, source}`, sent with `postWorker("reports/clarify", ...)`.
 */
export const CLARIFY_TIMEOUT_MS = 15_000;

/**
 * The follow-up questions in a `POST /v1/reports/clarify` answer: the strings
 * of its `questions`, at most two, or none when the answer is not the shape
 * the Worker sends (the wizard then carries on without questions).
 */
export function clarifyQuestions(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const questions = (body as { questions?: unknown }).questions;
  if (!Array.isArray(questions)) return [];
  return questions
    .filter((q): q is string => typeof q === "string" && q.trim() !== "")
    .slice(0, 2);
}

/**
 * The words to show for a refused request: the Worker's `error_description`,
 * else the fallback.
 */
export function reportRefusal(body: unknown, fallback: string): string {
  if (typeof body !== "object" || body === null) return fallback;
  const text = (body as { error_description?: unknown }).error_description;
  return typeof text === "string" && text.trim() ? text : fallback;
}

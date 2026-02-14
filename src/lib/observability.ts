/**
 * Observability — structured error logging and GA4 error event reporting.
 *
 * Netflix-style principle: the app shell NEVER crashes, but every failure
 * is captured, categorised, and observable so ops knows what's happening.
 *
 * Server-side: structured JSON logs with context (source, error type, location).
 * Client-side: GA4 exception events for error rate dashboards.
 */

// ── Error categories ────────────────────────────────────────────────────────

export type ErrorSource =
  | "weather-api"
  | "ai-api"
  | "history-api"
  | "geo-api"
  | "db-init-api"
  | "mongodb"
  | "tomorrow-io"
  | "open-meteo"
  | "anthropic"
  | "client-render"
  | "client-fetch"
  | "unhandled";

export type ErrorSeverity = "low" | "medium" | "high" | "critical";

interface ErrorContext {
  source: ErrorSource;
  severity: ErrorSeverity;
  location?: string;
  message: string;
  /** Original error (for stack traces in dev) */
  error?: unknown;
  /** Extra metadata */
  meta?: Record<string, unknown>;
}

// ── Server-side structured logging ──────────────────────────────────────────

/**
 * Log a structured error with context. In production (Vercel), these appear
 * as JSON in stdout and can be filtered/alerted on via Vercel Log Drains,
 * Datadog, or any log aggregation service.
 */
export function logError(ctx: ErrorContext) {
  const entry = {
    level: "error",
    ts: new Date().toISOString(),
    source: ctx.source,
    severity: ctx.severity,
    location: ctx.location,
    message: ctx.message,
    ...(ctx.meta ? { meta: ctx.meta } : {}),
    ...(ctx.error instanceof Error
      ? { errorName: ctx.error.name, stack: ctx.error.stack }
      : ctx.error !== undefined
        ? { errorValue: String(ctx.error) }
        : {}),
  };

  // Structured JSON — parseable by log aggregators
  console.error(JSON.stringify(entry));
}

/**
 * Log a structured warning (non-fatal degradation).
 */
export function logWarn(ctx: Omit<ErrorContext, "severity">) {
  const entry = {
    level: "warn",
    ts: new Date().toISOString(),
    source: ctx.source,
    location: ctx.location,
    message: ctx.message,
    ...(ctx.meta ? { meta: ctx.meta } : {}),
  };

  console.warn(JSON.stringify(entry));
}

// ── Client-side GA4 error reporting ─────────────────────────────────────────

/**
 * Report an error to Google Analytics 4 as an exception event.
 * This feeds into GA4 > Reports > Engagement > Events > exception,
 * giving ops a real-time dashboard of error rates without any
 * additional SaaS dependency.
 *
 * Only runs in the browser. No-ops silently on the server.
 */
export function reportErrorToAnalytics(
  description: string,
  fatal: boolean = false,
) {
  if (typeof window === "undefined") return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gtag = (window as any).gtag as
    | ((...args: unknown[]) => void)
    | undefined;

  if (typeof gtag === "function") {
    gtag("event", "exception", {
      description: description.slice(0, 150), // GA4 truncates at 150 chars
      fatal,
    });
  }
}

/**
 * Report a weather provider failure to analytics.
 * Tracks which providers are failing and how often.
 */
export function reportProviderFailure(
  provider: "tomorrow-io" | "open-meteo" | "mongodb" | "anthropic",
  errorType: string,
  location?: string,
) {
  reportErrorToAnalytics(
    `${provider}:${errorType}${location ? `:${location}` : ""}`,
    false,
  );
}

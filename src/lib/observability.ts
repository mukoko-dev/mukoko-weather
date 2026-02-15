/**
 * Observability — structured error logging, GA4 error reporting, and webhook alerting.
 *
 * Netflix-style principle: the app shell NEVER crashes, but every failure
 * is captured, categorised, and observable so ops knows what's happening.
 *
 * Three tiers of alerting:
 * 1. **Structured logs** — JSON to stdout, parseable by Vercel Log Drains / Datadog / Splunk
 * 2. **GA4 exception events** — real-time error rate dashboards in Google Analytics
 * 3. **Webhook alerts** — outbound HTTP notifications for critical/high severity events
 *    Set ALERT_WEBHOOK_URL env var to enable (Slack incoming webhook, Discord, PagerDuty, etc.)
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

export interface ErrorContext {
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

  // Automatically send webhook alert for high/critical severity
  sendAlert(ctx);
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

// ── Webhook alerting ─────────────────────────────────────────────────────────
//
// Sends outbound HTTP POST notifications for high/critical severity events.
// Set ALERT_WEBHOOK_URL env var to a Slack incoming webhook, Discord webhook,
// PagerDuty events API, or any service that accepts JSON POST.
//
// Features:
// - Deduplication: same source+message won't alert more than once per 5 minutes
// - Non-blocking: fire-and-forget, never throws or delays the caller
// - Slack-compatible payload format with severity emoji indicators

const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between duplicate alerts
const alertCooldowns = new Map<string, number>();

function shouldAlert(key: string): boolean {
  const now = Date.now();
  const lastAlerted = alertCooldowns.get(key);
  if (lastAlerted && now - lastAlerted < ALERT_COOLDOWN_MS) return false;
  alertCooldowns.set(key, now);
  // Prune old entries to prevent unbounded growth
  if (alertCooldowns.size > 100) {
    for (const [k, v] of alertCooldowns) {
      if (now - v > ALERT_COOLDOWN_MS) alertCooldowns.delete(k);
    }
  }
  return true;
}

const SEVERITY_EMOJI: Record<ErrorSeverity, string> = {
  low: "\u2139\uFE0F",      // ℹ️
  medium: "\u26A0\uFE0F",   // ⚠️
  high: "\uD83D\uDED1",     // 🛑
  critical: "\uD83D\uDD34", // 🔴
};

/**
 * Send a webhook alert for high/critical severity events.
 * Non-blocking — fire-and-forget. Safe to call from any context.
 *
 * Payload is Slack-compatible (works with Slack incoming webhooks out of the box).
 * Also includes structured fields for generic webhook consumers.
 */
export function sendAlert(ctx: ErrorContext): void {
  // Only alert on high/critical severity
  if (ctx.severity !== "high" && ctx.severity !== "critical") return;

  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  const dedupeKey = `${ctx.source}:${ctx.message}`;
  if (!shouldAlert(dedupeKey)) return;

  const emoji = SEVERITY_EMOJI[ctx.severity];
  const timestamp = new Date().toISOString();

  // Slack-compatible payload
  const payload = {
    text: `${emoji} *mukoko weather alert* — ${ctx.severity.toUpperCase()}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *${ctx.severity.toUpperCase()}* — \`${ctx.source}\`\n${ctx.message}${ctx.location ? `\n_Location: ${ctx.location}_` : ""}`,
        },
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `*Time:* ${timestamp}` },
          ...(ctx.meta ? [{ type: "mrkdwn", text: `*Meta:* ${JSON.stringify(ctx.meta)}` }] : []),
        ],
      },
    ],
    // Structured fields for non-Slack consumers
    mukoko_alert: {
      source: ctx.source,
      severity: ctx.severity,
      message: ctx.message,
      location: ctx.location,
      timestamp,
      meta: ctx.meta,
    },
  };

  // Fire-and-forget — never block the caller
  fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Silently swallow webhook delivery failures — we don't alert about alert failures
  });
}

// ── GitHub issue reporting ────────────────────────────────────────────────────

/**
 * Helper to build a GitHub issue URL pre-filled with error context.
 * Used by error boundaries to let users report issues directly.
 */
export function buildIssueUrl(context: {
  title: string;
  source?: string;
  message?: string;
  page?: string;
  digest?: string;
}): string {
  const params = new URLSearchParams({
    template: "bug_report.yml",
    title: `[Bug] ${context.title}`,
  });
  if (context.page) params.set("page-route", context.page);

  const body = [
    "## Auto-generated error report",
    "",
    context.message ? `**Error:** ${context.message}` : "",
    context.source ? `**Source:** ${context.source}` : "",
    context.page ? `**Page:** ${context.page}` : "",
    context.digest ? `**Digest:** ${context.digest}` : "",
    "",
    "## Steps to reproduce",
    "1. Visited the page above",
    "2. The error occurred automatically",
    "",
    "## Expected behaviour",
    "The page should load without errors.",
  ].filter(Boolean).join("\n");

  params.set("body", body);

  return `https://github.com/nyuchitech/mukoko-weather/issues/new?${params.toString()}`;
}

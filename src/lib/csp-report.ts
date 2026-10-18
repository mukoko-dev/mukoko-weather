/**
 * CSP violation report handling (framework-agnostic): parse, filter, dedupe
 * and rate-limit. Logging is the caller's job.
 */
import { sanitizePath } from "./location-privacy";

export const MAX_REPORT_BYTES = 8192;
export const MAX_ITEMS_PER_REQUEST = 5;

export interface CspEntry {
  directive: string;
  /** Blocked host (or keyword such as `inline`, `eval`), never a URL path. */
  blocked: string;
  /** Sanitised path of the page that reported. */
  page: string;
}

const EXTENSION_SCHEMES = [
  "chrome-extension",
  "moz-extension",
  "safari-extension",
  "safari-web-extension",
  "ms-browser-extension",
  "webkit-masked-url",
];

function blockedHost(u: unknown): string | null {
  if (typeof u !== "string" || !u) return "";
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(u);
  if (!m) return u.slice(0, 20);
  const scheme = m[1].toLowerCase();
  if (EXTENSION_SCHEMES.includes(scheme)) return null;
  if (scheme === "http" || scheme === "https") {
    try {
      return new URL(u).host.slice(0, 100);
    } catch {
      return "";
    }
  }
  return scheme; // data, blob, about, ...
}

function pagePath(u: unknown): string {
  if (typeof u !== "string") return "";
  try {
    return sanitizePath(new URL(u).pathname).slice(0, 80);
  } catch {
    return "";
  }
}

/** Extract loggable entries from a report body; extension noise is dropped. */
export function parseCspReports(parsed: unknown): CspEntry[] {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const out: CspEntry[] = [];
  for (const item of items.slice(0, MAX_ITEMS_PER_REQUEST)) {
    const r = (item ?? {}) as Record<string, unknown>;
    const body = (r["csp-report"] ?? r["body"] ?? r) as Record<string, unknown>;
    const blocked = blockedHost(body["blocked-uri"] ?? body["blockedURL"]);
    if (blocked === null) continue;
    const source = body["source-file"] ?? body["sourceFile"];
    if (
      typeof source === "string" &&
      EXTENSION_SCHEMES.some((s) => source.startsWith(`${s}:`))
    )
      continue;
    out.push({
      directive: String(
        body["effective-directive"] ??
          body["effectiveDirective"] ??
          body["violated-directive"] ??
          "",
      ).slice(0, 60),
      blocked,
      page: pagePath(body["document-uri"] ?? body["documentURL"]),
    });
  }
  return out;
}

/**
 * Per-instance gate: each distinct (directive, host, page) is logged once per
 * `dedupeMs`, and at most `maxPerMinute` lines go out in total, so a noisy
 * client or a flood can't drown the logs.
 */
export function createReportGate(
  opts: { dedupeMs?: number; maxPerMinute?: number; maxKeys?: number } = {},
) {
  const dedupeMs = opts.dedupeMs ?? 10 * 60_000;
  const maxPerMinute = opts.maxPerMinute ?? 30;
  const maxKeys = opts.maxKeys ?? 500;
  const seen = new Map<string, number>();
  let windowStart = 0;
  let count = 0;
  return {
    allow(e: CspEntry, now: number = Date.now()): boolean {
      if (now - windowStart >= 60_000) {
        windowStart = now;
        count = 0;
      }
      if (count >= maxPerMinute) return false;
      const key = `${e.directive}|${e.blocked}|${e.page}`;
      const last = seen.get(key);
      if (last !== undefined && now - last < dedupeMs) return false;
      if (seen.size >= maxKeys) {
        for (const [k, t] of seen) if (now - t >= dedupeMs) seen.delete(k);
        if (seen.size >= maxKeys) return false;
      }
      seen.set(key, now);
      count++;
      return true;
    },
    reset() {
      seen.clear();
      count = 0;
      windowStart = 0;
    },
  };
}

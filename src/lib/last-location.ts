/**
 * The `lastLocation` cookie: the slug of the last location page a visitor
 * opened. The edge proxy writes it (src/proxy.ts), the home page and the
 * display read it on the server, and the client refreshes it after a GPS
 * swap (current-slug.ts). Keep the name and the lifetime here only.
 *
 * proxy.ts imports just the constants from this module.
 */
import { LOCATION_SLUG_RE } from "@/lib/location-gate";

export const LAST_LOCATION_COOKIE = "lastLocation";

/** 30 days, in seconds. */
export const LAST_LOCATION_MAX_AGE_S = 2592000;

/** The subset of `cookies()` / `request.cookies` that the reader needs. */
export interface CookieJar {
  get(name: string): { value: string } | undefined;
}

/**
 * The remembered slug when the cookie holds a syntactically valid one, else
 * null. Callers still resolve it (a stale cookie must not strand a visitor).
 */
export function readLastLocation(jar: CookieJar): string | null {
  const value = jar.get(LAST_LOCATION_COOKIE)?.value;
  return value && LOCATION_SLUG_RE.test(value) ? value : null;
}

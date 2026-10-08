import { slugToDisplayName } from "@/lib/utils";

/**
 * Pure helpers for deriving which location the visitor is looking at.
 *
 * Shared by MyWeatherModal and Header so "the current location" can never
 * drift between the two. Nothing here reads the DOM or the store — callers
 * pass the pathname and the persisted selection in.
 */

/**
 * First path segments that are app routes, not location slugs.
 * Mirrors KNOWN_ROUTES in src/proxy.ts; current-slug.test.ts asserts that
 * every proxy.ts entry is present here.
 */
export const NON_LOCATION_ROUTES: ReadonlySet<string> = new Set([
  "explore",
  "locations",
  "shamwari",
  "history",
  "aviation",
  "about",
  "help",
  "privacy",
  "terms",
  "status",
  "embed",
  "offline",
  "api",
  "auth",
  "callback",
  // Account and app surfaces that are not weather pages
  "profile",
  "developers",
  "login",
  "signage",
  "display",
]);

const SLUG_RE = /^[a-z0-9-]{1,80}$/;

/** True when `value` is a syntactically valid location slug that is not a route. */
export function isLocationSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    SLUG_RE.test(value) &&
    !NON_LOCATION_ROUTES.has(value)
  );
}

/**
 * The slug of the location on screen.
 *
 * - On a location page (`/harare`, `/harare/forecast`, `/harare/` …) the
 *   FIRST path segment is the location.
 * - On `/`, on a non-location route (`/explore`, `/display` …), or on an
 *   unknown segment, the store's `selectedLocation` is used.
 * - Null when neither source is a real location slug. Callers must handle
 *   null rather than substituting a default city.
 */
export function currentLocationSlug(
  pathname: string | null | undefined,
  selectedLocation: string | null | undefined,
): string | null {
  const firstSegment =
    (pathname ?? "").split("/").find((segment) => segment.length > 0) ?? "";
  if (isLocationSlug(firstSegment)) return firstSegment;
  if (isLocationSlug(selectedLocation)) return selectedLocation;
  return null;
}

/** Trailing 6-hex platform hash (`harare-a1b2c3` → `harare`). */
const PLATFORM_HASH_RE = /-[0-9a-f]{6}$/;

/**
 * Human-readable name for a slug when no real name is known yet.
 * Smart slugs keep the name before the `--` delimiter; platform hash suffixes
 * are stripped before title-casing (`bulawayo-e7b1f4` → `Bulawayo`).
 */
export function displayNameFromSlug(slug: string): string {
  const namePart = slug.includes("--") ? slug.split("--")[0] : slug;
  const stripped = namePart.replace(PLATFORM_HASH_RE, "") || namePart;
  return slugToDisplayName(stripped);
}

/** Window event the header's "My Location" button fires when it resolves a
 *  place while the visitor is already on `/` (a router.push("/") would be a
 *  no-op there). CurrentLocationHome listens and swaps the dashboard. */
export const CURRENT_LOCATION_EVENT = "mukoko:current-location";

/**
 * Remember a GPS-confirmed place so the NEXT server render of `/` seeds it.
 * Same cookie name/options as the edge middleware (src/proxy.ts).
 */
export function writeLastLocationCookie(slug: string): void {
  if (!isLocationSlug(slug)) return;
  try {
    document.cookie = `lastLocation=${slug}; max-age=2592000; path=/; samesite=lax`;
  } catch {
    /* non-browser environment */
  }
}

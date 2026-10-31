import { slugToDisplayName } from "@/lib/utils";
import { LOCATION_SLUG_RE } from "@/lib/location-gate";
import {
  LAST_LOCATION_COOKIE,
  LAST_LOCATION_MAX_AGE_S,
} from "@/lib/last-location";

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
  "releases",
  "login",
  "signage",
  "display",
]);

/** True when `value` is a syntactically valid location slug that is not a route. */
export function isLocationSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    LOCATION_SLUG_RE.test(value) &&
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
  return slugToDisplayName(nameSegmentOf(slug));
}

/** True for a two-letter segment that is a real ISO 3166-1 region code. */
function isRegionCode(part: string): boolean {
  if (!/^[a-z]{2}$/.test(part)) return false;
  try {
    const upper = part.toUpperCase();
    const label = new Intl.DisplayNames(["en"], { type: "region" }).of(upper);
    return !!label && label !== upper;
  } catch {
    return false;
  }
}

/**
 * The name part of a slug: the text before a smart-slug `--`, minus a
 * platform hash and minus a trailing ISO country suffix (`{name}-{cc}`), which
 * is part of the URL, never of the place's name ("Phuket Island", not
 * "Phuket Island TH").
 */
function nameSegmentOf(slug: string): string {
  const namePart = slug.includes("--") ? slug.split("--")[0] : slug;
  const stripped = namePart.replace(PLATFORM_HASH_RE, "") || namePart;
  const parts = stripped.split("-");
  if (parts.length > 1 && isRegionCode(parts[parts.length - 1])) {
    return parts.slice(0, -1).join("-");
  }
  return stripped;
}

/**
 * For a legacy `{name}-{cc}` slug (no stored place, no coordinate in the
 * slug), the free-text name to search for and the country it names. Null for
 * slugs that carry a coordinate or a hash, or have no country suffix.
 */
export function legacySlugQuery(
  slug: string,
): { query: string; country: string } | null {
  if (slug.includes("--") || PLATFORM_HASH_RE.test(slug)) return null;
  const parts = slug.split("-");
  const last = parts[parts.length - 1];
  if (parts.length < 2 || !isRegionCode(last)) return null;
  return {
    query: slugToDisplayName(parts.slice(0, -1).join("-")),
    country: last.toUpperCase(),
  };
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
    document.cookie = `${LAST_LOCATION_COOKIE}=${slug}; max-age=${LAST_LOCATION_MAX_AGE_S}; path=/; samesite=lax`;
  } catch {
    /* non-browser environment */
  }
}

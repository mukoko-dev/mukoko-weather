/**
 * Location privacy helpers: what may leave the browser toward analytics.
 *
 * A smart slug (`west-paddock--ksy4dd7`) embeds a ~153 m geohash and its name
 * is often a street or POI, so it is a fine location. The URL itself stays the
 * shareable identity; only what is EXPORTED (GA4, Vercel Analytics, request
 * URLs that reach platform logs) is coarsened here.
 *
 * - legacy catalog slugs (`harare`, `nairobi-ke`) carry no coordinate: kept
 * - spots become `spot--<4-char geohash>` (about 39 x 20 km), name dropped
 * - OSM places become `place` (name and feature id dropped)
 */
import { parseSmartSlug } from "./smart-slug";

/** Geohash characters kept for a spot: a ~39 x 20 km cell. */
export const ANALYTICS_GEOHASH_CHARS = 4;

/** Decimal places for coordinates in request URLs and analytics (~110 m). */
export const COORD_DECIMALS = 3;

/** Round a coordinate to {@link COORD_DECIMALS} places. */
export function roundCoord(value: number): number {
  const f = 10 ** COORD_DECIMALS;
  return Math.round(value * f) / f;
}

/** Coarsen one slug for analytics. Non-smart slugs are returned unchanged. */
export function coarsenSlug(slug: string): string {
  const parsed = parseSmartSlug(slug);
  if (!parsed) return slug;
  if (parsed.ref.kind === "spot" && parsed.geohash) {
    return `spot--${parsed.geohash.slice(0, ANALYTICS_GEOHASH_CHARS)}`;
  }
  return "place";
}

/** Coarsen the slug segments of a path (`/west-paddock--ksy4dd7/forecast`). */
export function sanitizePath(path: string): string {
  return path
    .split("/")
    .map((seg) => {
      let decoded = seg;
      try {
        decoded = decodeURIComponent(seg);
      } catch {
        /* keep raw */
      }
      return coarsenSlug(decoded);
    })
    .join("/");
}

/**
 * Sanitise a URL for analytics: slug coarsened, query and hash dropped
 * (they can carry `lat`/`lon`). Unparseable input becomes "".
 */
export function sanitizeUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url, "https://weather.mukoko.com");
    const origin = /^https?:\/\//i.test(url) ? u.origin : "";
    return `${origin}${sanitizePath(u.pathname)}`;
  } catch {
    return "";
  }
}

/** Event property keys that hold a location slug. */
const SLUG_KEYS = new Set(["location", "from", "to", "slug"]);

/** Coarsen slug-valued properties of an analytics event. */
export function sanitizeEventProps<T extends object>(props: T): T {
  const out = { ...props } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) {
    if (SLUG_KEYS.has(k) && typeof v === "string") out[k] = coarsenSlug(v);
  }
  return out as T;
}

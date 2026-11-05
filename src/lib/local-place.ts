/**
 * The places a slug names WITHOUT any lookup: no database, no Worker, no
 * network (issue #452).
 *
 * A page's shell must not wait on data. Two kinds of place need none:
 *
 * - a shipped seed place (`harare`, `nairobi-ke`), known at build time, under
 *   its legacy slug or its canonical one (`harare--ksy4dd1`, #317). A
 *   canonical seed slug is a spot by grammar, so it is matched as the seed
 *   FIRST: the place keeps its own province, tags and elevation instead of
 *   becoming a bare coordinate;
 * - a spot (`{name}--{geohash}`), which carries its own coordinate.
 *
 * Anything else (a community place created through the platform, an OSM place
 * reference, an unknown name) can only be answered by a lookup, so the server
 * does not try: the page sends the shell and the browser resolves it
 * (`place-resolve.ts`, through the shared Worker read), showing the not-found
 * view there when nothing answers. The edge proxy (`location-gate.ts`) stays
 * the gate that turns an unknown slug into a real 404 before a page renders.
 *
 * Pure, and safe on the server and in the browser.
 */

import { nearestWithin } from "./geo";
import { LOCATIONS, type WeatherLocation } from "./locations";
import { CANONICAL_TO_LEGACY, canonicalSlug } from "./slug-migration";
import {
  coordinateLabel,
  isCoordinateNameSlug,
  parseSmartSlug,
} from "./smart-slug";

/**
 * The shipped places, keyed by the LEGACY slug (the seed list's own key).
 * Each carries its CANONICAL slug, which is what a page, a link and a saved
 * place use (#317).
 */
const CATALOGUE = new Map<string, WeatherLocation>(
  LOCATIONS.map((loc) => [loc.slug, { ...loc, slug: canonicalSlug(loc.slug) }]),
);

/**
 * A shipped seed place, or null. Accepts the legacy slug (`harare`) or the
 * canonical one (`harare--ksy4dd1`); the place returned carries the canonical
 * slug either way.
 */
export function catalogueLocation(slug: string): WeatherLocation | null {
  return CATALOGUE.get(CANONICAL_TO_LEGACY.get(slug) ?? slug) ?? null;
}

/**
 * The place a spot slug encodes: its own coordinate, the name in the URL, no
 * elevation or region of its own (the forecast fills both in).
 */
export function spotLocation(slug: string): WeatherLocation | null {
  const parsed = parseSmartSlug(slug);
  if (!parsed || parsed.ref.kind !== "spot") return null;
  const { lat, lon } = parsed;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const name = isCoordinateNameSlug(parsed.nameSlug)
    ? coordinateLabel(lat, lon)
    : parsed.name;
  return {
    slug,
    name: name || "Selected location",
    province: "",
    lat,
    lon,
    elevation: 0,
    elevationApproximate: true,
    tags: ["city"],
    source: "geolocation",
  };
}

/** How far a shipped place may lend its region to a spot (as the resolver does). */
const BORROW_REGION_KM = 250;

/**
 * A spot knows its coordinate and its name, not its country or province. The
 * nearest shipped place lends both, marked `regionApproximate` (it may sit
 * across a border: the forecast's time zone corrects it once it arrives), the
 * same regional approximation the stored-geography resolver makes last
 * (`resolveSmartSlug`, step 3), so the season and the breadcrumb can say
 * something sensible before the browser has asked for anything.
 */
function withBorrowedRegion(spot: WeatherLocation): WeatherLocation {
  const [near] = nearestWithin(
    LOCATIONS,
    (loc) => loc,
    spot.lat,
    spot.lon,
    BORROW_REGION_KM,
    1,
  );
  if (!near) return spot;
  const { province, country, elevation, tags } = near.item;
  return {
    ...spot,
    province,
    ...(country ? { country } : {}),
    elevation,
    tags,
    regionApproximate: true,
  };
}

/**
 * The place a slug names with no lookup, or null when only a lookup can tell
 * (the caller then sends the shell and resolves it in the browser). A shipped
 * place is the seed as it is; a spot borrows its region from the nearest
 * shipped place.
 */
export function localPlaceForSlug(slug: string): WeatherLocation | null {
  const seed = catalogueLocation(slug);
  if (seed) return seed;
  const spot = spotLocation(slug);
  return spot ? withBorrowedRegion(spot) : null;
}

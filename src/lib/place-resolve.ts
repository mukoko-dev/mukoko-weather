/**
 * Turn a slug into a place the stage can show, in the browser.
 *
 * Order, cheapest first (the stage has already tried memory and the device):
 *   1. the shipped catalogue (no request),
 *   2. the Worker's `/v1/locations?slug=` (community places, platform places),
 *      read through the shared fetch store (`workerData`), never a raw fetch,
 *   3. a spot slug (`{name}--{geohash}`), which carries its own coordinate.
 * Null means "not a place I can show in place": the caller falls back to a
 * normal navigation, where the server resolves it (or answers a real 404).
 *
 * The first and last steps need no lookup and live in `local-place.ts`, which
 * the server render shares (issue #452); this module re-exports them.
 */

import type { WeatherLocation } from "@/lib/locations";
import { getDefaultSeason } from "@/lib/weather";
import { countryDisplayName } from "@/lib/location-country";
import { workerData } from "@/lib/worker-data";
import { catalogueLocation, spotLocation } from "@/lib/local-place";
import type { PlaceSeed } from "@/lib/place-controller";

export { catalogueLocation, spotLocation };

/** The seed for a location: season by hemisphere, country name by code. */
export function seedFor(location: WeatherLocation): PlaceSeed {
  return {
    location,
    season: getDefaultSeason(new Date(), location.lat),
    countryName: countryDisplayName(location.country),
  };
}

interface WorkerLocation {
  slug?: unknown;
  name?: unknown;
  province?: unknown;
  lat?: unknown;
  lon?: unknown;
  elevation?: unknown;
  tags?: unknown;
  country?: unknown;
  source?: unknown;
  provinceSlug?: unknown;
  nominatimAddress?: unknown;
  regionApproximate?: unknown;
  elevationApproximate?: unknown;
}

/** A Worker location document as a WeatherLocation, or null when unusable. */
export function locationFromWorker(
  slug: string,
  doc: WorkerLocation | null | undefined,
): WeatherLocation | null {
  if (!doc) return null;
  const { lat, lon } = doc;
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const elevation = typeof doc.elevation === "number" ? doc.elevation : 0;
  return {
    slug,
    name:
      typeof doc.name === "string" && doc.name ? doc.name : "Selected location",
    province: typeof doc.province === "string" ? doc.province : "",
    lat,
    lon,
    elevation,
    tags: Array.isArray(doc.tags)
      ? doc.tags.filter((t): t is string => typeof t === "string")
      : [],
    ...(typeof doc.country === "string" && doc.country
      ? { country: doc.country }
      : {}),
    ...(typeof doc.provinceSlug === "string"
      ? { provinceSlug: doc.provinceSlug }
      : {}),
    ...(doc.source === "seed" ||
    doc.source === "community" ||
    doc.source === "geolocation"
      ? { source: doc.source }
      : {}),
    ...(doc.regionApproximate === true ? { regionApproximate: true } : {}),
    ...(doc.elevationApproximate === true || elevation === 0
      ? { elevationApproximate: true }
      : {}),
    ...(doc.nominatimAddress && typeof doc.nominatimAddress === "object"
      ? {
          nominatimAddress:
            doc.nominatimAddress as WeatherLocation["nominatimAddress"],
        }
      : {}),
  };
}

/** See the module comment. Never throws. */
export async function resolvePlaceSeed(
  slug: string,
  signal?: AbortSignal,
): Promise<PlaceSeed | null> {
  const known = catalogueLocation(slug);
  if (known) return seedFor(known);

  try {
    // Through the shared fetch store like every other Worker read: the same
    // slug asked twice (a double tap, a pager prefetch) is one request, and a
    // refused or unreachable answer is remembered briefly instead of asked
    // again on every attempt.
    const res = await workerData.read<{ location?: WorkerLocation }>(
      "locations",
      { slug },
      { signal },
    );
    if (res.ok) {
      const location = locationFromWorker(slug, res.data?.location);
      if (location) return seedFor(location);
    }
  } catch {
    // Unreachable: a spot still renders from its own slug, below.
  }

  const spot = spotLocation(slug);
  return spot ? seedFor(spot) : null;
}

/**
 * What the browser learned about a slug the server did not name (issue #452).
 *
 * - `found`: a place to show;
 * - `missing`: the Worker answered and holds no such place (HTTP 404, or an
 *   answer with no usable coordinate): the not-found view is right;
 * - `unavailable`: nothing answered (offline, slow, refused, a server error).
 *   That says nothing about the place, so it is never shown as "not found":
 *   the caller offers to try again.
 */
export type PlaceLookup =
  | { kind: "found"; seed: PlaceSeed }
  | { kind: "missing" }
  | { kind: "unavailable" };

/**
 * Resolve a slug in the browser: the lookups that need no request first
 * (shipped place, spot), then the Worker through the shared read. Unlike
 * `resolvePlaceSeed`, it keeps "no such place" apart from "could not ask".
 * Never throws.
 */
export async function lookupPlace(
  slug: string,
  signal?: AbortSignal,
  options: { force?: boolean } = {},
): Promise<PlaceLookup> {
  const known = catalogueLocation(slug) ?? spotLocation(slug);
  if (known) return { kind: "found", seed: seedFor(known) };
  try {
    const res = await workerData.read<{ location?: WorkerLocation }>(
      "locations",
      { slug },
      { signal, force: options.force },
    );
    if (res.ok) {
      const location = locationFromWorker(slug, res.data?.location);
      return location
        ? { kind: "found", seed: seedFor(location) }
        : { kind: "missing" };
    }
    return res.status === 404 ? { kind: "missing" } : { kind: "unavailable" };
  } catch {
    // The caller stopped waiting, or the read could not be made.
    return { kind: "unavailable" };
  }
}

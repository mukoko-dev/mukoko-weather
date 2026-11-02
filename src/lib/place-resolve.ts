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
 */

import { LOCATIONS, type WeatherLocation } from "@/lib/locations";
import { getDefaultSeason } from "@/lib/weather";
import { countryDisplayName } from "@/lib/location-country";
import { workerData } from "@/lib/worker-data";
import {
  coordinateLabel,
  isCoordinateNameSlug,
  parseSmartSlug,
} from "@/lib/smart-slug";
import type { PlaceSeed } from "@/lib/place-controller";

const CATALOGUE = new Map<string, WeatherLocation>(
  LOCATIONS.map((loc) => [loc.slug, loc]),
);

/** The seed for a location: season by hemisphere, country name by code. */
export function seedFor(location: WeatherLocation): PlaceSeed {
  return {
    location,
    season: getDefaultSeason(new Date(), location.lat),
    countryName: countryDisplayName(location.country),
  };
}

/** A shipped seed place, or null. */
export function catalogueLocation(slug: string): WeatherLocation | null {
  return CATALOGUE.get(slug) ?? null;
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

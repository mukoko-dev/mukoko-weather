/**
 * Canonical platform location helpers — reads/writes through `places.placesGeo`
 * (admin geography) and `places.places` (POIs from OSM/Fundi).
 *
 * Phase 0F: this file replaces all reads against the legacy `weather.locations`
 * collection. `weather.locations` is dropped — mukoko-weather is a consumer of
 * the platform's canonical geographic data, not a maintainer of a parallel
 * silo.
 *
 * Lookup chain (clean URL slug → placesGeo entry → adapted LocationDoc):
 *
 *   /harare
 *     │
 *     ▼
 *   resolveLocationSlug("harare")
 *     │
 *     ├─ 1. Try placesGeo by sourceProvenance.mukokoSlug = "harare"
 *     ├─ 2. Try static LOCATIONS[slug] → use its `name` to look up placesGeo
 *     │      by normalised name (case-insensitive, diacritic-stripped),
 *     │      preferring geoType: city > town > village
 *     └─ 3. Try inferring the name from the slug ("nairobi-ke" → "Nairobi")
 *           and the same name lookup as (2)
 *     │
 *     ▼
 *   adaptPlacesGeoToLocationDoc(placesGeoDoc, hint?)
 *     │
 *     ▼
 *   { slug, name, lat, lon, elevation, province, country, tags, ... }
 *
 * Why the static LOCATIONS array still matters: placesGeo does NOT carry the
 * mukoko-specific `tags`, `province`, `provinceSlug`, or `elevation` fields,
 * and even `country` lives one hop away on a parent doc. The static seed
 * array (98 ZW + 167 global) is kept as the slug→display-metadata bridge —
 * it stops being a seed source for the database but remains the canonical
 * mapping from clean URLs to display info for the locations we ship.
 *
 * Community-created locations are written into placesGeo with their clean
 * mukoko slug stamped onto `sourceProvenance.mukokoSlug` by the Python
 * `add_location` endpoint, so step (1) above resolves them directly.
 */

import { placesGeoCollection, placesCollection } from "./db";
import { LOCATIONS, type WeatherLocation, type NominatimAddress } from "./locations";

// ---------------------------------------------------------------------------
// Types — platform shape vs. mukoko shape
// ---------------------------------------------------------------------------

/** Document shape we read from `places.placesGeo` (subset we care about). */
export interface PlacesGeoDoc {
  _id: string;
  _schemaVersion?: string;
  name: string;
  slug?: string;
  geoType?: "country" | "province" | "city" | "town" | "village" | string;
  /** GeoJSON Point — coordinates are [lon, lat]. */
  geo?: { type: "Point"; coordinates: [number, number] };
  parentPlaceId?: string;
  /** ISO 3166-1 alpha-2 code denormalised onto city/province docs by mukoko writes. */
  isoCode?: string;
  sourceProvenance?: {
    dataOrigin?: string;
    dataConfidence?: number;
    /** Clean mukoko URL slug (e.g. "harare") — stamped by add_location. */
    mukokoSlug?: string;
    /** Cached display province (Nominatim admin1 / curated seed). */
    mukokoProvince?: string;
    /** Cached display elevation (metres). */
    mukokoElevation?: number;
    /** Mukoko-side tag taxonomy (city/farming/mining/…). */
    mukokoTags?: string[];
    /** Cached Nominatim structured address. */
    mukokoNominatimAddress?: NominatimAddress;
    /** Nearest-POI type stamped at create time (e.g. "school", "hospital"). */
    mukokoPoiType?: string;
  };
}

/** Document shape we read from `places.places` (subset we care about). */
export interface PlaceDoc {
  _id: string;
  name: string;
  slug?: string;
  placeType?: string[];
  additionalCategories?: string[];
  geo?: { type: "Point"; coordinates: [number, number] };
  hierarchy?: { containedInPlaceId?: string };
}

export interface BBox {
  /** GeoJSON-order: [minLon, minLat, maxLon, maxLat]. */
  bounds: [number, number, number, number];
}

/**
 * Adapted shape returned by resolveLocationSlug. Matches the legacy
 * `LocationDoc` consumers in src/app/[location]/* expect (lat, lon, name,
 * country, province, elevation, slug, _id) so we don't have to touch every
 * server component.
 */
export interface AdaptedLocation extends WeatherLocation {
  /** Platform placeId — placesGeo._id. */
  _id: string;
  /** Platform placesGeo.slug (hash-suffixed, e.g. "harare-a1b2c3"). */
  platformSlug?: string;
  /**
   * Nearest-POI type (e.g. "school", "hospital", "market", "park") when a
   * named POI was within POI_MATCH_RADIUS_KM at create time. Surfaced from
   * `sourceProvenance.mukokoPoiType` so the location page + AI summary can
   * mention it.
   */
  poiType?: string;
  /** Always set when adapted from placesGeo. */
  updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// Slug ⇄ name helpers
// ---------------------------------------------------------------------------

/** Static slug → seed metadata. Built once from LOCATIONS at module load. */
const SLUG_INDEX = new Map<string, WeatherLocation>(
  LOCATIONS.map((loc) => [loc.slug, loc]),
);

/** Strip diacritics, lowercase, collapse whitespace — used for cross-doc name comparison. */
export function normalizeName(name: string): string {
  if (!name) return "";
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Infer a display name from a clean URL slug. Used as a fallback when the
 * slug is not in LOCATIONS and not stamped onto a placesGeo doc.
 *
 * - "harare" → "Harare"
 * - "nairobi-ke" → "Nairobi" (strips trailing 2-letter country suffix)
 * - "victoria-falls" → "Victoria Falls"
 */
export function inferNameFromSlug(slug: string): string {
  if (!slug) return "";
  // Strip a trailing 2-letter country code (matches our `{city}-{country}` slug format).
  const withoutCountry = slug.replace(/-[a-z]{2}$/i, "");
  return withoutCountry
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Country ISO code cache — placesGeo parent lookup → ISO 3166-1 alpha-2
// ---------------------------------------------------------------------------

/** Resolved country ISO codes, keyed by placesGeo._id. */
const COUNTRY_ISO_BY_ID = new Map<string, string>();
/** When the cache was last populated (epoch ms). */
let countryCacheLoadedAt = 0;
const COUNTRY_CACHE_TTL_MS = 60 * 60 * 1000; // 1h

async function ensureCountryCache(): Promise<void> {
  const now = Date.now();
  if (COUNTRY_ISO_BY_ID.size > 0 && now - countryCacheLoadedAt < COUNTRY_CACHE_TTL_MS) {
    return;
  }
  try {
    const cursor = placesGeoCollection().find(
      { geoType: "country" },
      { projection: { _id: 1, isoCode: 1 } },
    );
    COUNTRY_ISO_BY_ID.clear();
    for await (const doc of cursor) {
      const id = (doc as unknown as { _id?: string })._id;
      const iso = (doc as unknown as { isoCode?: string }).isoCode;
      if (id && iso) COUNTRY_ISO_BY_ID.set(id, iso.toUpperCase());
    }
    countryCacheLoadedAt = now;
  } catch {
    // DB unavailable — leave the cache untouched, retry on next call.
  }
}

async function isoCodeForParent(parentPlaceId: string | undefined): Promise<string | undefined> {
  if (!parentPlaceId) return undefined;
  await ensureCountryCache();
  return COUNTRY_ISO_BY_ID.get(parentPlaceId);
}

// ---------------------------------------------------------------------------
// Adapter: placesGeo doc → AdaptedLocation (legacy LocationDoc shape)
// ---------------------------------------------------------------------------

/** Preferred ordering when multiple placesGeo entries share the same name. */
const GEO_TYPE_RANK: Record<string, number> = {
  city: 0,
  town: 1,
  village: 2,
  province: 3,
};

function rankGeoType(geoType: string | undefined): number {
  if (!geoType) return 99;
  return GEO_TYPE_RANK[geoType] ?? 50;
}

/**
 * Convert a placesGeo document to the legacy LocationDoc shape used by
 * page components. Falls back to the static LOCATIONS seed for fields
 * placesGeo doesn't carry (tags, elevation, provinceSlug).
 */
export async function adaptPlacesGeoToLocationDoc(
  doc: PlacesGeoDoc,
  hint: { cleanSlug: string; seed?: WeatherLocation },
): Promise<AdaptedLocation> {
  const [lon, lat] = doc.geo?.coordinates ?? [0, 0];
  const provenance = doc.sourceProvenance ?? {};

  const isoFromParent = await isoCodeForParent(doc.parentPlaceId);
  const country = (doc.isoCode ?? isoFromParent ?? hint.seed?.country ?? "").toUpperCase();

  const province =
    provenance.mukokoProvince ??
    hint.seed?.province ??
    "";

  const elevation =
    typeof provenance.mukokoElevation === "number"
      ? provenance.mukokoElevation
      : hint.seed?.elevation ?? 0;

  const tags = provenance.mukokoTags ?? hint.seed?.tags ?? ["city"];

  return {
    _id: doc._id,
    slug: hint.cleanSlug,
    platformSlug: doc.slug,
    name: doc.name,
    province,
    lat,
    lon,
    elevation,
    tags,
    country: country || undefined,
    poiType: provenance.mukokoPoiType,
    provinceSlug: hint.seed?.provinceSlug,
    nominatimAddress: provenance.mukokoNominatimAddress ?? hint.seed?.nominatimAddress,
    source: hint.seed?.source ?? "community",
    updatedAt: new Date(),
  };
}

// ---------------------------------------------------------------------------
// Resolver — clean URL slug → AdaptedLocation | null
// ---------------------------------------------------------------------------

/**
 * Canonical lookup for mukoko-weather URL slugs (e.g. `/harare`).
 *
 * Strategy:
 *   1. Try placesGeo by `sourceProvenance.mukokoSlug` match (exact).
 *   2. Else look up the slug in the static LOCATIONS seed to recover the
 *      display name + metadata, then find a placesGeo by normalised name
 *      (case-insensitive, diacritic-stripped) preferring
 *      geoType: city > town > village.
 *   3. Else infer the name from the slug ("nairobi-ke" → "Nairobi") and
 *      run the same name lookup.
 *
 * Returns the adapted doc (matching the legacy LocationDoc shape) or null.
 *
 * Dedup discipline (Phase 0E carried forward): when multiple placesGeo
 * entries match the same normalised name, we sort by geoType rank then by
 * `sourceProvenance.dataConfidence` desc — never by document age, never by
 * `-2`/`-3` suffix.
 */
export async function resolveLocationSlug(
  slug: string,
): Promise<AdaptedLocation | null> {
  if (!slug) return null;

  let coll;
  try {
    coll = placesGeoCollection();
  } catch {
    return null;
  }

  // 1) Exact match on stamped mukokoSlug.
  try {
    const stamped = (await coll.findOne({
      "sourceProvenance.mukokoSlug": slug,
    })) as unknown as PlacesGeoDoc | null;
    if (stamped) {
      return adaptPlacesGeoToLocationDoc(stamped, {
        cleanSlug: slug,
        seed: SLUG_INDEX.get(slug),
      });
    }
  } catch {
    // Continue to fallback strategies.
  }

  // 2 + 3) Name lookup — prefer seed name, fall back to inferred name.
  const seed = SLUG_INDEX.get(slug);
  const candidateName = seed?.name ?? inferNameFromSlug(slug);
  if (!candidateName) return null;

  const normalised = normalizeName(candidateName);

  let candidates: PlacesGeoDoc[] = [];
  try {
    // Case-insensitive regex on `name`; we filter further by normalised
    // comparison in JS to handle diacritics and whitespace variations the
    // regex can't easily cover.
    const escaped = candidateName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    candidates = (await coll
      .find({ name: { $regex: `^${escaped}$`, $options: "i" } })
      .limit(20)
      .toArray()) as unknown as PlacesGeoDoc[];
  } catch {
    return null;
  }

  // Filter strictly by normalised name (handles diacritics) and exclude
  // country-level entries — `/harare` should never resolve to a country.
  const matches = candidates.filter(
    (c) => c.geoType !== "country" && normalizeName(c.name) === normalised,
  );

  if (matches.length === 0) return null;

  // Dedup discipline: prefer better geoType, then higher data confidence.
  matches.sort((a, b) => {
    const rankDiff = rankGeoType(a.geoType) - rankGeoType(b.geoType);
    if (rankDiff !== 0) return rankDiff;
    const aConf = a.sourceProvenance?.dataConfidence ?? 0;
    const bConf = b.sourceProvenance?.dataConfidence ?? 0;
    return bConf - aConf;
  });

  return adaptPlacesGeoToLocationDoc(matches[0], { cleanSlug: slug, seed });
}

// ---------------------------------------------------------------------------
// Nearest placesGeo — IP/GPS reverse lookup
// ---------------------------------------------------------------------------

/**
 * Find the nearest placesGeo entry (city/town/village) to (lat, lon).
 * Uses $nearSphere on the 2dsphere index against the `geo` field.
 * Returns null if no entry is within maxKm.
 */
export async function nearestPlacesGeo(
  lat: number,
  lon: number,
  maxKm: number = 50,
): Promise<PlacesGeoDoc | null> {
  try {
    const doc = (await placesGeoCollection().findOne({
      geoType: { $in: ["city", "town", "village"] },
      geo: {
        $nearSphere: {
          $geometry: { type: "Point", coordinates: [lon, lat] },
          $maxDistance: Math.max(0, maxKm) * 1000,
        },
      },
    })) as unknown as PlacesGeoDoc | null;
    return doc;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Nearest place (POI) — tight-radius matching for location refinement
// ---------------------------------------------------------------------------

/**
 * Tight radius (km) for POI-nearest matching. POIs are point features (a
 * school, a shop, a clinic) — we only prefer one when the user is essentially
 * standing on it. Intentionally small (≤250 m): this is NOT a coarse city snap.
 */
export const POI_MATCH_RADIUS_KM = 0.25;

/**
 * Extract a single human-facing POI type from a `places.places` document.
 * Prefers the first `placeType`, then the first `additionalCategories` entry.
 * Returns `undefined` when neither carries a usable string.
 */
export function poiTypeFromPlace(doc: PlaceDoc | null | undefined): string | undefined {
  if (!doc) return undefined;
  const primary = doc.placeType?.find((t) => typeof t === "string" && t.trim());
  if (primary) return primary.trim();
  const extra = doc.additionalCategories?.find((t) => typeof t === "string" && t.trim());
  return extra ? extra.trim() : undefined;
}

/**
 * Find the nearest `places.places` POI to (lat, lon) within `maxKm`.
 * Uses `$nearSphere` on the 2dsphere index against `places.places.geo`.
 *
 * Returns `null` on any error, a missing index, or when nothing is in range —
 * POI matching must NEVER break location resolution, so every failure path
 * falls back to `null` and the caller keeps its reverse-geocode result.
 */
export async function nearestPlace(
  lat: number,
  lon: number,
  maxKm: number = POI_MATCH_RADIUS_KM,
): Promise<PlaceDoc | null> {
  try {
    const doc = (await placesCollection().findOne({
      geo: {
        $nearSphere: {
          $geometry: { type: "Point", coordinates: [lon, lat] },
          $maxDistance: Math.max(0, maxKm) * 1000,
        },
      },
    })) as unknown as PlaceDoc | null;
    return doc;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Search places (POIs) — used by explore/search flows
// ---------------------------------------------------------------------------

/**
 * Search `places.places` by name + optional bounding box for the
 * explore/search flows. Falls back to a `$text` search if a bbox isn't
 * provided. Returns up to 20 results.
 */
export async function searchPlaces(
  query: string,
  bbox?: BBox,
): Promise<PlaceDoc[]> {
  const q = (query ?? "").trim();
  if (!q) return [];

  try {
    const coll = placesCollection();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filter: Record<string, any> = {
      $text: { $search: q },
    };
    if (bbox) {
      const [minLon, minLat, maxLon, maxLat] = bbox.bounds;
      filter.geo = {
        $geoWithin: {
          $box: [
            [minLon, minLat],
            [maxLon, maxLat],
          ],
        },
      };
    }
    return (await coll
      .find(filter, { projection: { score: { $meta: "textScore" } } })
      .sort({ score: { $meta: "textScore" } })
      .limit(20)
      .toArray()) as unknown as PlaceDoc[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Misc helpers for callers that previously read weather.locations
// ---------------------------------------------------------------------------

/**
 * Static seed locations — used as a display fallback for the home page
 * chooser UI and for SEO sitemaps when placesGeo lookup is unavailable.
 *
 * Phase 0F: NOT a database seed source. The list lives in code purely as a
 * stable list of clean URL slugs the app ships with by default.
 */
export function listSeedLocations(): WeatherLocation[] {
  return LOCATIONS;
}

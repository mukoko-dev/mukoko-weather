/**
 * Smart slugs — `{name}--{geohash}` URLs that carry their own coordinates.
 *
 * The problem they solve: location pages used to require a `places.placesGeo`
 * document to exist *before* a URL could mean anything, because the slug's
 * `-a1b2c3` suffix was random hex. A place the platform geography hadn't mapped
 * yet had no renderable URL at all, so browsing or searching to it produced
 * "Location not found". The database was a gate.
 *
 * A smart slug inverts that. The geohash segment decodes to a coordinate box
 * locally — no database, no network — so the page can always render, and the
 * database becomes an *enrichment* that adds a better name, province, elevation
 * and tags when it happens to have them.
 *
 *   /harare--ksy4dd7        → -17.8288, 31.0522   (Harare, 153 m box)
 *   /singapore--w21zdqp     →   1.3520, 103.8201
 *   /mbare-musika--ksy4d6r  → a POI-level spot inside Harare
 *
 * ## Why the delimiter is `--` and not `-`
 *
 * The geohash alphabet excludes a/i/l/o, but plenty of ordinary words survive
 * that filter. Six of the app's own existing seed slugs are *themselves* valid
 * geohash strings — `gweru`, `kwekwe`, `chegutu`, `guruve`, `gutu`, `ngundu`.
 * Read as a geohash, `gweru` decodes to 82.95° N in the Arctic Ocean. With a
 * single-dash delimiter, a trailing name segment of the right length and
 * alphabet would be silently mistaken for a coordinate and render weather for
 * the wrong hemisphere.
 *
 * Slugification collapses every run of non-alphanumerics to one `-`, so `--`
 * cannot occur in a generated name. Requiring it makes the parse unambiguous,
 * and it is why there is deliberately no bare-geohash URL form.
 */

import {
  DEFAULT_GEOHASH_PRECISION,
  encodeGeohash,
  type GeohashBounds,
} from "./geohash";
import {
  formatPlaceRefSegment,
  parseRefSegment,
  type LocationRef,
} from "./place-ref";

/** Separator between the human name and the geohash. Never occurs in a slugified name. */
export const SMART_SLUG_DELIMITER = "--";

/** Validate an OSM ref for slug construction; returns the canonical form or null. */
function parseOsmRefForBuild(ref: string): string | null {
  const match = /^([nwr])([0-9]{1,19})$/.exec((ref ?? "").toLowerCase());
  if (!match) return null;
  const [, letter, digits] = match;
  if (digits.length > 1 && digits.startsWith("0")) return null;
  return `${letter}${digits}`;
}

/**
 * Longest ref segment we accept. Comfortably fits `osm-` plus a 19-digit OSM id
 * and any sane geohash; anything longer is not a ref we minted.
 */
const MAX_REF_SEGMENT_LENGTH = 32;

/** Maximum length of the name portion, so the whole slug stays a sane URL. */
const MAX_NAME_LENGTH = 60;

export interface ParsedSmartSlug {
  /** The slugified name portion, e.g. "mbare-musika". */
  nameSlug: string;
  /** Human-readable name recovered from `nameSlug`, e.g. "Mbare Musika". */
  name: string;
  /**
   * What the slug identifies — a map feature (`kind: "place"`) or a bare
   * coordinate (`kind: "spot"`). This is the identity; everything else on this
   * object is presentation.
   */
  ref: LocationRef;
  /** The geohash segment. Present only for a spot — a place has no coordinate in its URL. */
  geohash?: string;
  /** Centre of the geohash cell. Spot only. */
  lat?: number;
  lon?: number;
  /** The cell bounds. Spot only. */
  bounds?: GeohashBounds;
  /** Half the cell diagonal in km. Spot only. */
  errorKm?: number;
}

/**
 * Slugify a place name: strip diacritics, lowercase, collapse everything
 * non-alphanumeric to single dashes.
 *
 * Mirrors `_generate_slug` in `api/py/_locations.py` minus its country suffix —
 * with smart slugs the coordinate carries the geography, so the country code no
 * longer has to be smuggled into the name.
 */
export function slugifyName(name: string): string {
  if (!name) return "";
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LENGTH)
    .replace(/-+$/g, "");
}

/**
 * Recover a display name from a slugified name segment.
 * "mbare-musika" → "Mbare Musika".
 */
export function nameFromSlugSegment(nameSlug: string): string {
  if (!nameSlug) return "";
  return nameSlug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Build a smart slug for a named coordinate.
 *
 * Deterministic: the same name and coordinate always produce the same slug, so
 * two independent requests for the same place converge on one URL instead of
 * minting rivals the way a random suffix did.
 *
 * Returns "" when the coordinate is unusable — callers should fall back to a
 * legacy slug rather than emit a URL that decodes to nowhere.
 */
export function buildSmartSlug(
  name: string,
  lat: number,
  lon: number,
  precision: number = DEFAULT_GEOHASH_PRECISION,
): string {
  const geohash = encodeGeohash(lat, lon, precision);
  if (!geohash) return "";
  const nameSlug = slugifyName(name);
  // A nameless place still gets a usable URL; "place" beats a bare "--hash",
  // which would look broken and is not a form the parser accepts.
  const prefix = nameSlug || "place";
  return `${prefix}${SMART_SLUG_DELIMITER}${geohash}`;
}

/**
 * Build the slug for a PLACE — a named feature the map already knows about.
 *
 * The identity is the map's, so this slug is stable across visits, across GPS
 * jitter, and across any later improvement to the feature's name. Two adjacent
 * features produce two different slugs, which is precisely what lets a person
 * save Canberra Residences and Visionaire as separate places.
 *
 * Returns "" when the ref is unusable, so callers fall back to a spot slug
 * rather than emitting a URL that identifies nothing.
 */
export function buildPlaceSlug(name: string, osmRef: string): string {
  const parsed = parseOsmRefForBuild(osmRef);
  if (!parsed) return "";
  const prefix = slugifyName(name) || "place";
  return `${prefix}${SMART_SLUG_DELIMITER}${formatPlaceRefSegment(parsed)}`;
}

/**
 * Parse a smart slug into its name and decoded coordinate.
 *
 * Returns null for anything that isn't a smart slug — including every legacy
 * slug (`harare`, `nairobi-ke`), which by design contains no `--` and must keep
 * resolving through the existing catalog/placesGeo path.
 */
export function parseSmartSlug(slug: string): ParsedSmartSlug | null {
  if (!slug || !slug.includes(SMART_SLUG_DELIMITER)) return null;

  // Split on the LAST delimiter: a name may legitimately contain one.
  const idx = slug.lastIndexOf(SMART_SLUG_DELIMITER);
  const nameSlug = slug.slice(0, idx);
  const segment = slug.slice(idx + SMART_SLUG_DELIMITER.length);

  if (!segment || segment.length > MAX_REF_SEGMENT_LENGTH) return null;

  const ref = parseRefSegment(segment);
  if (!ref) return null;

  const base = {
    nameSlug,
    name: nameFromSlugSegment(nameSlug),
    ref,
  };

  // A place carries no coordinate in its URL — the map holds that, and our
  // records cache it. A spot IS its coordinate.
  if (ref.kind === "spot") {
    return {
      ...base,
      geohash: ref.geohash,
      lat: ref.lat,
      lon: ref.lon,
      bounds: ref.bounds,
      errorKm: ref.errorKm,
    };
  }

  return base;
}

/** True when `slug` is a parseable smart slug. */
export function isSmartSlug(slug: string): boolean {
  return parseSmartSlug(slug) !== null;
}

/**
 * True when `slug` uses the legacy form (no coordinate embedded) and must be
 * resolved through the static catalog / placesGeo chain.
 */
export function isLegacySlug(slug: string): boolean {
  return !!slug && !isSmartSlug(slug);
}

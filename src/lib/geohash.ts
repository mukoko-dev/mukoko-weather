/**
 * Geohash — self-describing coordinate encoding.
 *
 * A geohash encodes a lat/lon box into a short base-32 string. Longer strings
 * mean smaller boxes. Crucially it is *self-describing*: a geohash decodes to
 * coordinates with no database, no network call and no prior knowledge, which
 * is what lets `/{name}--{geohash}` URLs render a weather page for anywhere on
 * Earth without a place record having to exist first.
 *
 * Why this and not a random suffix: `places.placesGeo` slugs used a random
 * 6-hex suffix (`harare-a1b2c3`) which carries no information — the only way to
 * learn where `a1b2c3` is, is to look it up, so the record had to exist before
 * the URL could mean anything. A geohash carries the location *in* the slug, so
 * the database becomes an enrichment rather than a precondition.
 *
 * Standard geohash, unmodified: base-32 alphabet excluding a/i/l/o (so it
 * survives being read aloud and typo-corrected), longitude bit first, 5 bits
 * per character.
 */

/** Base-32 alphabet. Excludes a, i, l, o to avoid look-alike confusion. */
const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

/** Reverse lookup, char → 5-bit value. */
const BASE32_INDEX: Record<string, number> = {};
for (let i = 0; i < BASE32.length; i++) BASE32_INDEX[BASE32[i]] = i;

/** Matches a syntactically valid geohash of any length. */
export const GEOHASH_RE = /^[0123456789bcdefghjkmnpqrstuvwxyz]+$/;

/**
 * Default precision for mukoko location slugs: 7 characters ≈ a 153 m × 153 m
 * box. Fine enough to distinguish a school from the street outside it (matching
 * the app's POI-level naming) without minting a distinct URL for every few
 * metres of GPS jitter.
 */
export const DEFAULT_GEOHASH_PRECISION = 7;

/**
 * Approximate cell dimensions per precision, in metres. Indexed by length.
 * Used for choosing a search radius when enriching a decoded coordinate.
 */
export const GEOHASH_CELL_METRES: Record<
  number,
  { width: number; height: number }
> = {
  1: { width: 5_009_400, height: 4_992_600 },
  2: { width: 1_252_300, height: 624_100 },
  3: { width: 156_500, height: 156_000 },
  4: { width: 39_100, height: 19_500 },
  5: { width: 4_900, height: 4_900 },
  6: { width: 1_200, height: 609 },
  7: { width: 153, height: 152 },
  8: { width: 38, height: 19 },
  9: { width: 5, height: 5 },
};

export interface GeohashBounds {
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
}

export interface DecodedGeohash {
  /** Centre of the cell. */
  lat: number;
  lon: number;
  /** The cell itself — the coordinate is known only to within these bounds. */
  bounds: GeohashBounds;
  /** Half the cell diagonal, in km — a natural radius for "near this cell". */
  errorKm: number;
}

/**
 * True when `value` is a syntactically valid geohash string.
 *
 * Case-insensitive: canonical slugs are lowercase, but URLs get typed, pasted
 * and capitalised by messaging apps, and rejecting `/HARARE--KSY4DD7` would
 * hand the visitor a 404 over letter case alone.
 */
export function isGeohash(value: string): boolean {
  return !!value && GEOHASH_RE.test(value.toLowerCase());
}

/**
 * Encode a WGS 84 coordinate to a geohash of `precision` characters.
 *
 * Returns "" for non-finite or out-of-range input rather than throwing — a bad
 * coordinate must not be able to take down a render path.
 */
export function encodeGeohash(
  lat: number,
  lon: number,
  precision: number = DEFAULT_GEOHASH_PRECISION,
): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return "";
  const len = Math.max(1, Math.min(12, Math.floor(precision)));

  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;

  let hash = "";
  let bits = 0;
  let bitCount = 0;
  // Longitude is encoded first, then alternating.
  let isLon = true;

  while (hash.length < len) {
    if (isLon) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) {
        bits = (bits << 1) | 1;
        lonMin = mid;
      } else {
        bits = bits << 1;
        lonMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) {
        bits = (bits << 1) | 1;
        latMin = mid;
      } else {
        bits = bits << 1;
        latMax = mid;
      }
    }
    isLon = !isLon;

    if (++bitCount === 5) {
      hash += BASE32[bits];
      bits = 0;
      bitCount = 0;
    }
  }

  return hash;
}

/**
 * Decode a geohash to the centre of its cell plus the cell bounds.
 * Returns null for anything that isn't a valid geohash.
 */
export function decodeGeohash(geohash: string): DecodedGeohash | null {
  if (!isGeohash(geohash)) return null;
  const normalised = geohash.toLowerCase();

  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let isLon = true;

  for (const char of normalised) {
    const value = BASE32_INDEX[char];
    if (value === undefined) return null;
    // Most significant of the 5 bits first.
    for (let mask = 16; mask >= 1; mask >>= 1) {
      const bit = (value & mask) !== 0;
      if (isLon) {
        const mid = (lonMin + lonMax) / 2;
        if (bit) lonMin = mid;
        else lonMax = mid;
      } else {
        const mid = (latMin + latMax) / 2;
        if (bit) latMin = mid;
        else latMax = mid;
      }
      isLon = !isLon;
    }
  }

  const lat = (latMin + latMax) / 2;
  const lon = (lonMin + lonMax) / 2;

  // Half the cell diagonal, as a great-circle-ish approximation. Latitude
  // degrees are ~111 km throughout; longitude degrees shrink with latitude.
  const latSpanKm = (latMax - latMin) * 111.32;
  const lonSpanKm =
    (lonMax - lonMin) * 111.32 * Math.cos((lat * Math.PI) / 180);
  const errorKm = Math.sqrt(latSpanKm * latSpanKm + lonSpanKm * lonSpanKm) / 2;

  return {
    lat,
    lon,
    bounds: { latMin, latMax, lonMin, lonMax },
    errorKm,
  };
}

/**
 * The eight geohash cells surrounding `geohash`, at the same precision.
 *
 * Derived by decoding the cell and re-encoding points one cell away in each
 * direction, which keeps this table-free. Coordinates are clamped at the poles
 * and wrapped across the antimeridian, and any duplicate or self-match is
 * dropped, so a cell at an edge simply returns fewer than eight neighbours.
 */
export function geohashNeighbors(geohash: string): string[] {
  const decoded = decodeGeohash(geohash);
  if (!decoded) return [];

  const { bounds } = decoded;
  const latStep = bounds.latMax - bounds.latMin;
  const lonStep = bounds.lonMax - bounds.lonMin;
  const precision = geohash.length;

  const out = new Set<string>();
  for (const dLat of [-1, 0, 1]) {
    for (const dLon of [-1, 0, 1]) {
      if (dLat === 0 && dLon === 0) continue;

      const lat = decoded.lat + dLat * latStep;
      if (lat < -90 || lat > 90) continue; // No cell beyond a pole.

      // Wrap longitude across the antimeridian.
      let lon = decoded.lon + dLon * lonStep;
      if (lon > 180) lon -= 360;
      if (lon < -180) lon += 360;

      const neighbor = encodeGeohash(lat, lon, precision);
      if (neighbor && neighbor !== geohash) out.add(neighbor);
    }
  }
  return [...out];
}

/**
 * Longest shared prefix of two geohashes — a cheap proximity signal, since
 * geohashes sharing a longer prefix are (almost always) closer together.
 *
 * The "almost" matters: cells straddling a bit boundary can be adjacent yet
 * share no prefix, so use this as a hint, never as a distance metric.
 */
export function geohashCommonPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}

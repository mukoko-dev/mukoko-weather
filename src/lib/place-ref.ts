/**
 * Place references — the identity half of a location URL.
 *
 * A location slug is `{name}--{ref}`, and there are exactly two kinds of ref
 * because there are exactly two kinds of thing a person points at:
 *
 *   /canberra-residences--osm-w890123   a PLACE   — a named feature on the map
 *   /west-paddock--ksy4dd7              a SPOT    — a bare coordinate
 *
 * ## Why places cannot be identified by their coordinate
 *
 * The obvious design — round the coordinate to a cell and call that the
 * identity — cannot work, and the reason is worth stating because it is not
 * obvious until you try it:
 *
 *   - A cell coarse enough to absorb GPS jitter (±15 m is routine) is also
 *     coarse enough to swallow neighbouring places. Canberra Plaza and
 *     Canberra MRT are ~100 m apart and would merge into one record.
 *   - A cell fine enough to separate them (~5 m) is finer than the jitter, so
 *     the same doorway lands in a different cell on every visit and identity
 *     stops being stable — the exact bug the cell was introduced to fix.
 *
 * Those two requirements point in opposite directions, so no precision setting
 * satisfies both. Identity has to come from somewhere other than the
 * coordinate, and the map is the natural source: OSM already assigns every
 * feature a stable id, already distinguishes Canberra Residences from
 * Visionaire, and is maintained by people who care about exactly that.
 *
 * ## Where the geohash still belongs
 *
 * Demoted from identity to two jobs it is genuinely good at:
 *   - a spatial index — "what places are near me", which is how candidates get
 *     offered in the first place;
 *   - the identity of a SPOT, for coordinates with no map feature at all. That
 *     is not an edge case here: a farm boundary or a grazing paddock in rural
 *     Zimbabwe frequently has nothing mapped on it, and those users still need
 *     a saveable, shareable weather URL.
 *
 * ## Why the two forms can never be confused
 *
 * The geohash alphabet deliberately excludes `a`, `i`, `l` and `o`. The place
 * prefix is `osm-`, which contains an `o` and a `-`. A geohash therefore cannot
 * spell the prefix, and no discriminator flag or length heuristic is needed —
 * the alphabets simply do not overlap.
 */

import { decodeGeohash, isGeohash, type GeohashBounds } from "./geohash";

/** Prefix marking a map-feature ref. Contains `o`, which no geohash can. */
export const OSM_REF_PREFIX = "osm-";

/** `n` node · `w` way · `r` relation — the letters OSM uses in its own permalinks. */
export type OsmElementType = "n" | "w" | "r";

const OSM_TYPE_NAMES: Record<OsmElementType, string> = {
  n: "node",
  w: "way",
  r: "relation",
};

/** A ref that identifies a named feature on the map. */
export interface PlaceRef {
  kind: "place";
  /** Canonical short form, e.g. `"w890123"`. */
  ref: string;
  osmType: OsmElementType;
  osmId: string;
}

/** A ref that identifies a bare coordinate with no map feature. */
export interface SpotRef {
  kind: "spot";
  geohash: string;
  lat: number;
  lon: number;
  bounds: GeohashBounds;
  errorKm: number;
}

export type LocationRef = PlaceRef | SpotRef;

/** Matches the short OSM ref form: a type letter followed by digits. */
const OSM_REF_RE = /^([nwr])([0-9]{1,19})$/;

/**
 * Longest geohash accepted as a spot ref. Beyond 12 the extra characters buy
 * sub-metre precision nobody asked for, and — because a spot's identity IS its
 * geohash string — they would let one physical location spell itself many ways,
 * which is the fragmentation this whole design exists to prevent.
 */
const MAX_GEOHASH_LENGTH = 12;

/**
 * Parse a bare OSM ref (`"w890123"`) into its parts. Returns null if it is not
 * one — including for a leading zero, which would make two spellings of the
 * same id and therefore two identities for one place.
 */
export function parseOsmRef(ref: string): PlaceRef | null {
  if (!ref) return null;
  const match = OSM_REF_RE.exec(ref.toLowerCase());
  if (!match) return null;
  const [, letter, digits] = match;
  if (digits.length > 1 && digits.startsWith("0")) return null;
  return {
    kind: "place",
    ref: `${letter}${digits}`,
    osmType: letter as OsmElementType,
    osmId: digits,
  };
}

/** Human-readable element type, e.g. `"way"`. Useful in debug output and logs. */
export function osmTypeName(type: OsmElementType): string {
  return OSM_TYPE_NAMES[type];
}

/** Format a place ref for use in a slug: `"w890123"` → `"osm-w890123"`. */
export function formatPlaceRefSegment(ref: string): string {
  return `${OSM_REF_PREFIX}${ref.toLowerCase()}`;
}

/**
 * Parse the suffix of a location slug into whichever kind of ref it is.
 *
 * `"osm-w890123"` → a place · `"ksy4dd7"` → a spot · anything else → null.
 */
export function parseRefSegment(segment: string): LocationRef | null {
  if (!segment) return null;
  const lower = segment.toLowerCase();

  if (lower.startsWith(OSM_REF_PREFIX)) {
    return parseOsmRef(lower.slice(OSM_REF_PREFIX.length));
  }

  if (lower.length <= MAX_GEOHASH_LENGTH && isGeohash(lower)) {
    const decoded = decodeGeohash(lower);
    if (!decoded) return null;
    return {
      kind: "spot",
      geohash: lower,
      lat: decoded.lat,
      lon: decoded.lon,
      bounds: decoded.bounds,
      errorKm: decoded.errorKm,
    };
  }

  return null;
}

/**
 * Do two refs denote the same thing?
 *
 * This is the join rule, and it is deliberately strict for places: two records
 * merge only when the map says they are the same feature. Proximity is NOT
 * sufficient and must never be treated as such — that is what previously
 * collapsed distinct neighbouring places into one record, and what would stop
 * a user saving Canberra Residences and Visionaire separately.
 *
 * A place and a spot never merge even at identical coordinates: the paddock and
 * the farmhouse standing on it are different things to a person.
 */
export function refsIdentifySameThing(a: LocationRef, b: LocationRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "place" && b.kind === "place") return a.ref === b.ref;
  if (a.kind === "spot" && b.kind === "spot") return a.geohash === b.geohash;
  return false;
}

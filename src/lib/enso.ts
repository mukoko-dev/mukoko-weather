/**
 * ENSO (El Niño–Southern Oscillation) helpers — pure, no DOM or fetch.
 *
 * `ensoImpact` turns the global ENSO phase into 1–3 plain-language lines for
 * the location's region. The climatology is well established but regional and
 * seasonal, so every line is hedged ("tends to", "often") and none promises a
 * particular outcome.
 *
 * Region rules, checked in order:
 *   1. Southeast Asia (by country code)
 *   2. East Africa (by country code)
 *   3. Southern Africa (by country code), or any location south of 8°S that is
 *      not in the lists above. The latitude rule is deliberately broad, so
 *      non-African southern locations (e.g. Australia, Peru) also get the
 *      southern-Africa lines. That is a known limitation, not a feature.
 *   4. Everything else gets a generic line.
 */

export type EnsoPhase = "El Niño" | "La Niña" | "Neutral";

const SOUTHERN_AFRICA = new Set([
  "ZW",
  "ZA",
  "ZM",
  "MZ",
  "MW",
  "BW",
  "NA",
  "LS",
  "SZ",
]);

const EAST_AFRICA = new Set(["KE", "TZ", "UG", "ET", "RW", "BI", "SO"]);

const SOUTHEAST_ASIA = new Set([
  "SG",
  "MY",
  "ID",
  "TH",
  "PH",
  "VN",
  "BN",
  "KH",
  "LA",
  "MM",
]);

/** Latitude south of which the southern-Africa guidance applies (degrees). */
export const SOUTHERN_TROPICS_LAT = -8;

type Region = "southern-africa" | "east-africa" | "southeast-asia" | "other";

export function ensoRegion(
  countryCode: string | undefined,
  lat: number,
): Region {
  const cc = countryCode?.toUpperCase();
  if (cc && SOUTHEAST_ASIA.has(cc)) return "southeast-asia";
  if (cc && EAST_AFRICA.has(cc)) return "east-africa";
  if (cc && SOUTHERN_AFRICA.has(cc)) return "southern-africa";
  if (Number.isFinite(lat) && lat < SOUTHERN_TROPICS_LAT) {
    return "southern-africa";
  }
  return "other";
}

const IMPACTS: Record<EnsoPhase, Record<Region, string[]>> = {
  "El Niño": {
    "southern-africa": [
      "El Niño tends to bring a drier, hotter rainy season to southern Africa.",
      "Plan for drought-tolerant seed and staggered planting.",
      "Prioritise water harvesting and storage for dry spells.",
    ],
    "east-africa": [
      "El Niño is often linked to wetter short rains (October to December) in East Africa.",
      "Watch for flooding and landslide risk in low-lying and steep areas.",
    ],
    "southeast-asia": [
      "El Niño tends to bring drier conditions to Southeast Asia.",
      "Dry spells raise the risk of haze and vegetation fires; check air quality daily.",
    ],
    other: [
      "El Niño can shift rainfall and temperature patterns in many regions; effects vary locally.",
    ],
  },
  "La Niña": {
    "southern-africa": [
      "La Niña tends to bring wetter conditions to southern Africa's rainy season.",
      "Watch for flood risk in low-lying areas and waterlogged fields.",
      "Wet conditions favour crop disease; scout fields regularly.",
    ],
    "east-africa": [
      "La Niña is often linked to drier short rains (October to December) in East Africa.",
      "Plan water supply and livestock feed for a possible dry spell.",
    ],
    "southeast-asia": [
      "La Niña tends to bring wetter conditions to much of Southeast Asia.",
      "Watch for flooding, especially in river catchments.",
    ],
    other: [
      "La Niña can shift rainfall and temperature patterns in many regions; effects vary locally.",
    ],
  },
  Neutral: {
    "southern-africa": [
      "No strong ENSO signal right now, so seasonal outlooks rely on other drivers.",
    ],
    "east-africa": [
      "No strong ENSO signal right now, so seasonal outlooks rely on other drivers.",
    ],
    "southeast-asia": [
      "No strong ENSO signal right now, so seasonal outlooks rely on other drivers.",
    ],
    other: [
      "No strong ENSO signal right now, so seasonal outlooks rely on other drivers.",
    ],
  },
};

/**
 * Plain-language impact lines (1–3) for a location, given the global ENSO
 * phase. Returns copies, so callers may mutate the result safely.
 */
export function ensoImpact(
  phase: EnsoPhase,
  countryCode: string | undefined,
  lat: number,
): string[] {
  const region = ensoRegion(countryCode, lat);
  return [...IMPACTS[phase][region]];
}

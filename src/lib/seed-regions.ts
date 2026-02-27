/**
 * Seed data for the `regions` MongoDB collection.
 *
 * Read only by `POST /api/db-init` (one-time bootstrap) and tests.
 * At runtime, callers use `isInSupportedRegionFromDb()` from db.ts.
 *
 * Regions cover all developing countries globally:
 *   - All of Africa (full continent, including North Africa)
 *   - ASEAN (10 member nations + Papua New Guinea / Pacific proximity)
 *   - South Asia (India, Pakistan, Bangladesh, Sri Lanka, Nepal, Bhutan, Afghanistan, Maldives)
 *   - Middle East (Arabian Peninsula, Levant, Iran, Iraq)
 *   - Central Asia (Kazakhstan, Kyrgyzstan, Tajikistan, Turkmenistan, Uzbekistan, Mongolia)
 *   - South America (all 12 countries)
 *   - Central America, Mexico & Caribbean (Mexico, Central America, Caribbean islands)
 *   - Eastern Europe (Ukraine, Romania, Moldova, Bulgaria, Serbia, Bosnia, Albania, etc.)
 */

export interface RegionDoc {
  id: string;
  name: string;
  north: number;
  south: number;
  east: number;
  west: number;
  center: { lat: number; lon: number };
  active: boolean;
  /** Degrees of padding for isInSupportedRegion checks (default 1) */
  padding: number;
}

export const REGIONS: RegionDoc[] = [
  {
    id: "zw",
    name: "Zimbabwe",
    north: -15.61,
    south: -22.42,
    east: 33.07,
    west: 25.24,
    center: { lat: -19.02, lon: 29.15 },
    active: true,
    padding: 1,
  },
  // Africa — full continent (all 54 AU member states, including North Africa)
  {
    id: "africa",
    name: "Africa",
    north: 38.0,   // northern tip of Tunisia/Morocco (Bizerte ~37.3°N)
    south: -35.0,  // southern tip of South Africa (Cape Agulhas ~34.8°S)
    east: 52.0,    // eastern tip of Somalia/Djibouti (Ras Hafun ~51.3°E)
    west: -18.0,   // western tip (Senegal/Cape Verde ~-25°W; mainland -17.5°W)
    center: { lat: 1.5, lon: 17.0 },
    active: true,
    padding: 1,
  },
  // ASEAN — 10 member nations + nearby Pacific island proximity
  {
    id: "asean",
    name: "ASEAN",
    north: 28.5,
    south: -11.0,
    east: 141.0,
    west: 92.0,
    center: { lat: 8.0, lon: 115.0 },
    active: true,
    padding: 1,
  },
  // South Asia — India, Pakistan, Bangladesh, Sri Lanka, Nepal, Bhutan, Maldives, Afghanistan
  {
    id: "south-asia",
    name: "South Asia",
    north: 38.5,   // northern Pakistan/Afghanistan
    south: -1.0,   // southern Maldives atolls
    east: 98.0,    // eastern Bangladesh/Myanmar border
    west: 60.0,    // western Pakistan/Afghanistan (Iranian border)
    center: { lat: 22.0, lon: 79.0 },
    active: true,
    padding: 1,
  },
  // Middle East — Arabian Peninsula, Levant, Iran, Iraq, Turkey (southern)
  {
    id: "middle-east",
    name: "Middle East",
    north: 42.0,   // northern Turkey (Ankara ~40°N) / Syria border
    south: 12.0,   // southern Yemen (Aden ~12.8°N)
    east: 65.0,    // eastern Iran/Afghanistan border (Zahedan ~60.8°E)
    west: 25.0,    // western Turkey/Cyprus (Antalya ~30.7°E) / Jordan
    center: { lat: 27.0, lon: 45.0 },
    active: true,
    padding: 1,
  },
  // Central Asia — Kazakhstan, Kyrgyzstan, Tajikistan, Turkmenistan, Uzbekistan + Mongolia
  {
    id: "central-asia",
    name: "Central Asia",
    north: 56.0,   // northern Kazakhstan (Petropavl ~54.9°N)
    south: 35.0,   // southern Afghanistan/Pakistan border
    east: 125.0,   // eastern Mongolia (Choibalsan ~114°E)
    west: 46.0,    // western Kazakhstan (Caspian Sea coast)
    center: { lat: 45.0, lon: 80.0 },
    active: true,
    padding: 1,
  },
  // South America — all 12 countries
  {
    id: "south-america",
    name: "South America",
    north: 13.5,   // northern Venezuela/Colombia/Trinidad (Punto Gallinas ~12.4°N)
    south: -57.0,  // southern tip of Chile/Argentina (Cape Horn ~55.9°S)
    east: -34.0,   // eastern Brazil (Recife ~-35°W)
    west: -82.0,   // western Colombia/Ecuador/Peru (Galápagos ~-91°W; mainland -81°W)
    center: { lat: -15.0, lon: -58.0 },
    active: true,
    padding: 1,
  },
  // Central America, Mexico & Caribbean — Mexico, all Central American nations, Caribbean islands
  {
    id: "central-america",
    name: "Central America, Mexico & Caribbean",
    north: 33.0,   // northern Mexico (US border ~32.7°N)
    south: 7.0,    // southern Panama (Punta Mariato ~7.2°N)
    east: -59.0,   // easternmost Caribbean (Barbados ~-59.5°W)
    west: -122.0,  // western Baja California (Cabo San Lucas ~-109°W; extended for margins)
    center: { lat: 20.0, lon: -90.0 },
    active: true,
    padding: 1,
  },
  // Eastern Europe — Ukraine, Romania, Moldova, Bulgaria, Serbia, Bosnia, Albania, North Macedonia, etc.
  {
    id: "eastern-europe",
    name: "Eastern Europe",
    north: 56.0,   // northern Ukraine/Belarus border (~55.5°N)
    south: 35.0,   // southern Greece/Crete (~35°N) / Albania
    east: 46.0,    // eastern Georgia (Tbilisi ~44.8°E, eastern border ~46.7°E)
    west: 14.0,    // western Croatia/Slovenia (~14°E)
    center: { lat: 45.0, lon: 28.0 },
    active: true,
    padding: 1,
  },
  // Pacific Island nations — Papua New Guinea, Fiji, Solomon Islands, Vanuatu, etc.
  {
    id: "pacific-islands",
    name: "Pacific Islands",
    north: 20.0,   // Marshall Islands, Micronesia (~19°N)
    south: -25.0,  // Tonga, Fiji (~-21°S)
    east: -176.0,  // Tonga / Samoa (~-172°W)
    west: 130.0,   // Palau / western Micronesia (~134°E)
    center: { lat: 0.0, lon: -170.0 },
    active: true,
    padding: 1,
  },
];

/**
 * Backward-compatible aliases — these were previously exported from locations.ts.
 * Import from seed-regions.ts for tests and db-init; use isInSupportedRegionFromDb() at runtime.
 */
export const SUPPORTED_REGIONS = REGIONS;
export const ZIMBABWE_BOUNDS = REGIONS[0];

/** Synchronous region check — for tests and db-init only. Production uses isInSupportedRegionFromDb(). */
export function isInSupportedRegionSync(lat: number, lon: number): boolean {
  return REGIONS.some(
    (r) =>
      r.active &&
      lat >= r.south - r.padding &&
      lat <= r.north + r.padding &&
      lon >= r.west - r.padding &&
      lon <= r.east + r.padding,
  );
}

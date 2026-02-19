/**
 * Seed data for the `regions` MongoDB collection.
 *
 * Read only by `POST /api/db-init` (one-time bootstrap) and tests.
 * At runtime, callers use `isInSupportedRegionFromDb()` from db.ts.
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
  // ASEAN bounding box (covers all 10 member nations)
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
  // Sub-Saharan Africa (developing nations)
  {
    id: "africa-dev",
    name: "Africa (Developing)",
    north: 15.0,
    south: -35.0,
    east: 52.0,
    west: -18.0,
    center: { lat: -5.0, lon: 25.0 },
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

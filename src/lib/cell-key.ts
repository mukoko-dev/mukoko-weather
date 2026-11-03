/**
 * The 0.05 degree (~5.6 km) grid cell of a coordinate, `cell:-17.85_31.05`.
 *
 * A mirror of `weather_core::geo::cell_key` (`workers/crates/weather-core/src/geo.rs`),
 * the key the Worker's own weather, haze and air-quality caches use, pinned to
 * the same vectors (`tests/fixtures/weather-cache-keys.json`). The shared
 * client store (`worker-data.ts`) keys every read by this cell, so one place
 * and its neighbours cost one call. Built from integer cell indices, never
 * from formatted floats.
 */

/** Grid size in degrees. Change it here AND in `weather_core::geo::cell_key`. */
export const CELL_GRID_DEG = 0.05;
const CELLS_PER_DEG = 20; // 1 / CELL_GRID_DEG
const LAT_MAX_IDX = 90 * CELLS_PER_DEG;
const LON_MAX_IDX = 180 * CELLS_PER_DEG;

export const CELL_KEY_PREFIX = "cell:";

function cellIndex(value: number): number {
  // Round half up, the same as the Worker (floor(x + 0.5)).
  return Math.floor(value * CELLS_PER_DEG + 0.5);
}

function fmt(idx: number): string {
  const hundredths = idx * 5; // one cell = 0.05 degrees = 5 hundredths
  const sign = hundredths < 0 ? "-" : "";
  const a = Math.abs(hundredths);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/** The cell key for a coordinate. */
export function cellKey(lat: number, lon: number): string {
  const latIdx = Math.max(-LAT_MAX_IDX, Math.min(LAT_MAX_IDX, cellIndex(lat)));
  let lonIdx = cellIndex(lon);
  // +180 and -180 are the same meridian.
  if (lonIdx >= LON_MAX_IDX) {
    lonIdx -= 2 * LON_MAX_IDX;
  } else if (lonIdx < -LON_MAX_IDX) {
    lonIdx += 2 * LON_MAX_IDX;
  }
  return `${CELL_KEY_PREFIX}${fmt(latIdx)}_${fmt(lonIdx)}`;
}

/**
 * Coordinate-grid key for `weather.weather_cache` rows (issue #252).
 *
 * Mirror of `api/py/_weather_cache_key.py`, which belongs to the single cache
 * writer (`GET /api/py/weather`, issue #101). The SSR reader
 * (`getWeatherForLocation` in `db.ts`) must derive exactly the key the writer
 * writes. Both are pinned to `tests/fixtures/weather-cache-keys.json`.
 *
 * Grid: 0.05 degrees (~5.6 km). See the Python module for why that size was
 * chosen. The key is built from integer cell indices, never from formatted
 * floats, so both languages agree bit for bit.
 */

/** Grid size in degrees. Change it here AND in api/py/_weather_cache_key.py. */
export const WEATHER_CACHE_GRID_DEG = 0.05;
const CELLS_PER_DEG = 20; // 1 / WEATHER_CACHE_GRID_DEG
const LAT_MAX_IDX = 90 * CELLS_PER_DEG;
const LON_MAX_IDX = 180 * CELLS_PER_DEG;

export const WEATHER_CACHE_KEY_PREFIX = "cell:";

function cellIndex(value: number): number {
  // Round half up, the same as Python's math.floor(x + 0.5).
  return Math.floor(value * CELLS_PER_DEG + 0.5);
}

function fmt(idx: number): string {
  const hundredths = idx * 5; // one cell = 0.05 degrees = 5 hundredths
  const sign = hundredths < 0 ? "-" : "";
  const a = Math.abs(hundredths);
  return `${sign}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

/** The `weather_cache.locationSlug` value for a coordinate. */
export function weatherCacheKey(lat: number, lon: number): string {
  const latIdx = Math.max(-LAT_MAX_IDX, Math.min(LAT_MAX_IDX, cellIndex(lat)));
  let lonIdx = cellIndex(lon);
  // +180 and -180 are the same meridian.
  if (lonIdx >= LON_MAX_IDX) {
    lonIdx -= 2 * LON_MAX_IDX;
  } else if (lonIdx < -LON_MAX_IDX) {
    lonIdx += 2 * LON_MAX_IDX;
  }
  return `${WEATHER_CACHE_KEY_PREFIX}${fmt(latIdx)}_${fmt(lonIdx)}`;
}

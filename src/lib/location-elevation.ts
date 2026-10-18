import type { WeatherLocation } from "./locations";

/**
 * Real land spans about -430 m (Dead Sea shore) to 8 849 m (Everest), and
 * Open-Meteo sends -9999 for "no data", so anything outside this is not a
 * measurement.
 */
const MIN_ELEVATION_M = -1000;
const MAX_ELEVATION_M = 9000;

/**
 * Give a place the forecast's terrain height when we hold none for it (#302).
 *
 * Spot slugs and the IP fallback carry a placeholder elevation (0) or one
 * borrowed from a nearby place, flagged `elevationApproximate`. Open-Meteo
 * reports the height it used for the exact point (`WeatherData.elevation`),
 * so the page states the real one instead of "0 metres above sea level".
 * A place with a stored elevation is returned unchanged.
 */
export function reconcileElevation<T extends WeatherLocation>(
  location: T,
  forecastElevation: number | null | undefined,
): T {
  if (!location.elevationApproximate) return location;
  if (
    typeof forecastElevation !== "number" ||
    !Number.isFinite(forecastElevation) ||
    forecastElevation <= MIN_ELEVATION_M ||
    forecastElevation >= MAX_ELEVATION_M
  ) {
    return location;
  }
  return {
    ...location,
    elevation: Math.round(forecastElevation),
    elevationApproximate: false,
  };
}

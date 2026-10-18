/**
 * Pure decisions about what a geo lookup answered, shared by the home page
 * (server) and `CurrentLocationHome` (client) so they are testable without
 * rendering. The Worker's `/v1/geo` flags a spot two different ways
 * (`weather_core::resolve`):
 *
 * - `named: false`: a DEFINITIVE "nothing here" (open water, polar ice, empty
 *   desert). The coordinate label is the right name; there is no better place.
 * - `namingSkipped: true`: naming was skipped (over budget, the geocoder down,
 *   or the caller asked not to spend a lookup). That says nothing about the
 *   point, so it must never replace a real place that was available.
 */
import type { GeoResult } from "./geolocation";
import type { WeatherLocation } from "./locations";

/** A seed this close to the fix is "the same area" (matches the Worker's
 * SEED_NEAR_KM). */
export const SEED_NEAR_KM = 50;

/** The `nearest` object of a `/geo` answer, as the Worker sends it. */
export interface GeoNearest extends WeatherLocation {
  named?: boolean;
  namingSkipped?: boolean;
}

/** A coordinate label rather than a place's name (either flag). */
export function isPlaceholderSpot(nearest: GeoNearest | null | undefined) {
  return nearest?.named === false || nearest?.namingSkipped === true;
}

/**
 * Whether the home page's IP lookup should use this answer as the seeded
 * location. A placeholder spot is not a name for the visitor's place: the IP
 * city header names it better (`ipFallbackLocation`), so it is ignored.
 */
export function usableIpGeo(
  nearest: GeoNearest | null | undefined,
): nearest is GeoNearest {
  return !!nearest && !!nearest.slug && !isPlaceholderSpot(nearest);
}

/**
 * Whether a find-only GPS answer should be followed by a create-on-demand
 * call: a spot named on demand, or a stored place kilometres from the fix.
 * Never for a placeholder spot: there is nothing better to create, and asking
 * again would only spend the geocoder budget.
 */
export function shouldCreate(result: GeoResult, farKm: number): boolean {
  if (result.unnamed || result.namingSkipped) return false;
  return (
    result.synthesized === true ||
    (result.distanceKm != null && result.distanceKm > farKm)
  );
}

/**
 * Which location to show after the create-on-demand call.
 *
 * `precise` is the create answer. If it is only a placeholder spot but the
 * find-only answer was a real stored place within {@link SEED_NEAR_KM}, keep
 * that place: a coordinate label must never replace a real one.
 */
export function chooseResolved(
  found: GeoResult,
  precise: GeoResult | null,
): WeatherLocation {
  const fallback = found.location as WeatherLocation;
  if (
    !precise ||
    (precise.status !== "success" && precise.status !== "created") ||
    !precise.location
  ) {
    return fallback;
  }
  const preciseIsPlaceholder = precise.unnamed || precise.namingSkipped;
  const foundIsRealPlace =
    !found.synthesized &&
    !found.unnamed &&
    !found.namingSkipped &&
    found.distanceKm != null &&
    found.distanceKm <= SEED_NEAR_KM;
  if (preciseIsPlaceholder && foundIsRealPlace) return fallback;
  return precise.location;
}

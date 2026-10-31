import { FLIGHT_SCALE } from "./weather-scales";

/**
 * Shared flight-category (VFR/MVFR/IFR/LIFR) badge color mapping — used by
 * both AviationWeather (location-page aviation section) and AviationPlanner
 * (the /aviation pre-flight briefing tool) so the safety-relevant flight
 * category color coding can't drift between the two.
 *
 * Colours are the aviation-chart convention (VFR green, MVFR blue, IFR red,
 * LIFR magenta) from weather-scales.ts, not brand or severity colours.
 */
export const FLIGHT_CATEGORY_STYLES: Record<string, string> =
  Object.fromEntries(
    FLIGHT_SCALE.bands.map((band) => [band.name, `${band.bg} ${band.on}`]),
  );

export function getFlightCategoryClass(flightCategory: string): string {
  return (
    FLIGHT_CATEGORY_STYLES[flightCategory] ??
    "bg-surface-dim text-text-secondary"
  );
}

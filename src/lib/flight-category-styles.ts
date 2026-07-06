/**
 * Shared flight-category (VFR/MVFR/IFR/LIFR) badge color mapping — used by
 * both AviationWeather (location-page aviation section) and AviationPlanner
 * (the /aviation pre-flight briefing tool) so the safety-relevant flight
 * category color coding can't drift between the two.
 */
export const FLIGHT_CATEGORY_STYLES: Record<string, string> = {
  VFR: "bg-severity-low text-severity-fg",
  MVFR: "bg-primary text-primary-foreground",
  IFR: "bg-severity-high text-severity-fg",
  LIFR: "bg-severity-severe text-severity-fg",
};

export function getFlightCategoryClass(flightCategory: string): string {
  return FLIGHT_CATEGORY_STYLES[flightCategory] ?? "bg-surface-dim text-text-secondary";
}

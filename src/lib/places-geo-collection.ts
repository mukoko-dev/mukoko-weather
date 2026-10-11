import { placesDb } from "./mongo";

/**
 * Administrative geography — `places.placesGeo` (camelCase).
 *
 * Lives in its own module (re-exported from db.ts) so the location resolver,
 * which the proxy imports for the location gate (#263), doesn't drag the
 * whole of db.ts into the proxy bundle that runs on every page request.
 */
export function placesGeoCollection() {
  return placesDb().collection("placesGeo");
}

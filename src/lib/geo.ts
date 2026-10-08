/**
 * Shared geodesy helpers (WGS 84 decimal degrees).
 *
 * One implementation for every "how far / which is nearest" decision in the
 * client and in the static seed scans, so the formula and the sort/filter
 * semantics cannot drift between call sites.
 */

const EARTH_RADIUS_KM = 6371;

/** Great-circle distance in km between two WGS 84 points (haversine). */
export function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** An item plus its great-circle distance from the query point. */
export interface NearestMatch<T> {
  item: T;
  distanceKm: number;
}

/**
 * The `count` items closest to (lat, lon), nearest first, excluding anything
 * farther than `maxKm`. Ties keep input order (stable sort).
 *
 * `getLatLon` maps an item to its coordinates; keeping that a callback lets
 * airports, seed locations and API payloads share the same scan.
 */
export function nearestWithin<T>(
  items: readonly T[],
  getLatLon: (item: T) => { lat: number; lon: number },
  lat: number,
  lon: number,
  maxKm: number = Infinity,
  count: number = Infinity,
): NearestMatch<T>[] {
  return items
    .map((item) => {
      const point = getLatLon(item);
      return { item, distanceKm: haversineKm(lat, lon, point.lat, point.lon) };
    })
    .filter((match) => match.distanceKm <= maxKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, count);
}

import type { WeatherLocation } from "./locations";
import { nearestSeedLocation } from "./places";
import { buildSmartSlug } from "./smart-slug";

/**
 * The home seed when the platform geography knows nothing near the visitor's
 * IP position — which, with only African countries stored, was every visitor
 * in London, Tokyo or São Paulo: they got an empty chooser instead of weather.
 *
 * 1. The nearest shipped seed, but only in the visitor's own country: a seed
 *    250 km away can sit across a border (Tangier for a visitor in Málaga).
 * 2. Else a spot at the IP position, named after Vercel's city header. A spot
 *    slug carries its coordinate, so the page and its links render anywhere.
 *    The country comes from Vercel's header; the forecast's time zone
 *    confirms or fills it later (reconcileCountry).
 *
 * IP geolocation is city-level at best, so the spot is snapped to a
 * {@link IP_SPOT_GRID_DEG} grid before its slug is minted: encoding the raw
 * IP point at 153 m would claim a precision it does not have, give every
 * ISP block in one city a different slug, and miss the shared weather cache.
 */
/** Grid (degrees, ~11 km) an IP position is snapped to before minting a slug. */
export const IP_SPOT_GRID_DEG = 0.1;

/** Snap an IP-derived coordinate to the {@link IP_SPOT_GRID_DEG} grid. */
export function snapIpCoord(value: number): number {
  return Number(
    (Math.round(value / IP_SPOT_GRID_DEG) * IP_SPOT_GRID_DEG).toFixed(1),
  );
}

export function ipFallbackLocation(
  lat: number,
  lon: number,
  ipCountry: string | null,
  ipCity: string | null,
): WeatherLocation | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const country = (ipCountry ?? "").trim().toUpperCase();
  const seed = nearestSeedLocation(lat, lon);
  if (seed && (!country || (seed.country ?? "").toUpperCase() === country)) {
    return seed;
  }
  let city = "";
  try {
    city = decodeURIComponent(ipCity ?? "").trim();
  } catch {
    city = "";
  }
  const name = city || "My location";
  const spotLat = snapIpCoord(lat);
  const spotLon = snapIpCoord(lon);
  const slug = buildSmartSlug(name, spotLat, spotLon);
  if (!slug) return null;
  return {
    slug,
    name,
    province: "",
    lat: spotLat,
    lon: spotLon,
    elevation: 0,
    tags: ["city"],
    country: /^[A-Z]{2}$/.test(country) ? country : undefined,
    source: "geolocation",
  };
}

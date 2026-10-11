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
 */
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
  const slug = buildSmartSlug(name, lat, lon);
  if (!slug) return null;
  return {
    slug,
    name,
    province: "",
    lat,
    lon,
    elevation: 0,
    tags: ["city"],
    country: /^[A-Z]{2}$/.test(country) ? country : undefined,
    source: "geolocation",
  };
}

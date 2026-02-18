/**
 * Geocoding utilities for mukoko weather.
 *
 * - Reverse geocoding: Nominatim (OpenStreetMap) — coordinates to place name
 * - Forward geocoding: Open-Meteo — place name to coordinates
 */

export interface GeocodingResult {
  name: string;
  country: string; // ISO 3166-1 alpha-2
  countryName: string;
  admin1: string; // Province/state/region
  lat: number;
  lon: number;
  elevation: number;
  timezone?: string;
}

const USER_AGENT = "mukoko-weather/1.0 (https://weather.mukoko.com)";

// ---------------------------------------------------------------------------
// Reverse geocoding — Nominatim (coordinates to name)
// ---------------------------------------------------------------------------

/**
 * Reverse geocode coordinates to a place name using Nominatim.
 * Rate limit: max 1 request/second (acceptable for infrequent location creation).
 */
export async function reverseGeocode(
  lat: number,
  lon: number,
): Promise<GeocodingResult | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&zoom=10&addressdetails=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return null;

    const data = await res.json();
    if (!data || !data.address) return null;

    const address = data.address;
    const name =
      address.city ??
      address.town ??
      address.village ??
      address.hamlet ??
      address.suburb ??
      address.county ??
      data.name ??
      "Unknown";

    const admin1 =
      address.state ??
      address.province ??
      address.region ??
      address.county ??
      "";

    const countryCode = (address.country_code ?? "").toUpperCase();

    return {
      name,
      country: countryCode,
      countryName: address.country ?? "",
      admin1,
      lat: Number(data.lat ?? lat),
      lon: Number(data.lon ?? lon),
      elevation: 0, // Nominatim doesn't return elevation — fetched separately
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Forward geocoding — Open-Meteo (name to coordinates)
// ---------------------------------------------------------------------------

/**
 * Forward geocode a place name to coordinates using Open-Meteo.
 * Returns up to `count` results ranked by relevance.
 */
export async function forwardGeocode(
  query: string,
  options: { count?: number } = {},
): Promise<GeocodingResult[]> {
  const { count = 5 } = options;
  try {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=${count}&language=en&format=json`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return [];

    const data = await res.json();
    if (!data.results || !Array.isArray(data.results)) return [];

    return data.results.map(
      (r: {
        name: string;
        country_code: string;
        country: string;
        admin1?: string;
        latitude: number;
        longitude: number;
        elevation?: number;
        timezone?: string;
      }) => ({
        name: r.name,
        country: (r.country_code ?? "").toUpperCase(),
        countryName: r.country ?? "",
        admin1: r.admin1 ?? "",
        lat: r.latitude,
        lon: r.longitude,
        elevation: r.elevation ?? 0,
        timezone: r.timezone,
      }),
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Elevation lookup — Open-Meteo
// ---------------------------------------------------------------------------

/**
 * Fetch elevation for coordinates using Open-Meteo elevation API.
 */
export async function getElevation(lat: number, lon: number): Promise<number> {
  try {
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lon}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return 0;
    const data = await res.json();
    return data.elevation?.[0] ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Slug generation
// ---------------------------------------------------------------------------

/**
 * Generate a URL-safe slug from a location name and country.
 * For non-ZW locations, appends country code to reduce collisions.
 */
export function generateSlug(name: string, country: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics
    .replace(/[^a-z0-9\s-]/g, "") // remove non-alphanumeric
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

  // Append country code for non-Zimbabwe locations to reduce slug collisions
  if (country && country !== "ZW") {
    return `${base}-${country.toLowerCase()}`;
  }

  return base;
}

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
  /** Nominatim place type (e.g. "city", "village", "national_park") */
  placeType?: string;
  /** Nominatim OSM category (e.g. "place", "boundary", "leisure") */
  placeCategory?: string;
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
      placeType: data.type ?? undefined,
      placeCategory: data.category ?? undefined,
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

// ---------------------------------------------------------------------------
// Tag inference — AI-powered with basic fallback
// ---------------------------------------------------------------------------

const VALID_TAGS = ["city", "farming", "mining", "tourism", "education", "border", "travel", "national-park"];

/**
 * Use Claude to intelligently classify a location into our tag categories.
 *
 * Sends place name, region, country, and coordinates to Claude and asks
 * it to return the appropriate tags based on its knowledge of the area.
 * Falls back to `inferTagsBasic` if the AI call fails or no API key is set.
 */
export async function inferTags(geocoded: GeocodingResult): Promise<string[]> {
  // Try AI-powered inference first
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return inferTagsBasic(geocoded);

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey });

    const prompt = `Classify this location into one or more of these categories. Be generous — if a place is known for something nearby, include it.

Categories:
- city: Any city, town, village, or settlement where people live
- farming: Areas known for agriculture, farming regions, crop production
- mining: Areas with mining activity, mineral extraction, quarries
- tourism: Tourist destinations, landmarks, scenic areas, or places near major attractions
- education: University towns, places with major educational institutions
- border: Border crossings, border towns
- travel: Major transport corridors, highway towns, transit hubs
- national-park: National parks, game reserves, wildlife areas, conservation zones

Location: ${geocoded.name}
Region: ${geocoded.admin1}
Country: ${geocoded.countryName || geocoded.country}
Coordinates: ${geocoded.lat}, ${geocoded.lon}
OSM type: ${geocoded.placeType || "unknown"}

Respond with ONLY a JSON array of matching category strings, e.g. ["city", "tourism"]. Always include at least one category. Keep it broad — most settlements should have "city".`;

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 100,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]) as string[];
      const valid = parsed.filter((t) => VALID_TAGS.includes(t));
      if (valid.length > 0) return valid;
    }
  } catch {
    // AI call failed — fall through to basic inference
  }

  return inferTagsBasic(geocoded);
}

/**
 * Basic tag inference from geocoding data (fallback when AI is unavailable).
 * Uses OSM place type and name keywords. Always returns at least one tag.
 */
export function inferTagsBasic(geocoded: GeocodingResult): string[] {
  const type = (geocoded.placeType ?? "").toLowerCase();
  const name = geocoded.name.toLowerCase();

  const tags: Set<string> = new Set();

  // Most places are settlements
  if (["city", "town", "village", "hamlet", "suburb", "municipality"].includes(type) || !type) {
    tags.add("city");
  }

  if (type === "national_park" || type === "nature_reserve" || name.includes("national park") || name.includes("game reserve")) {
    tags.add("national-park");
    tags.add("tourism");
  }

  if (name.includes("falls") || name.includes("ruins") || name.includes("resort") || name.includes("dam") || name.includes("lake")) {
    tags.add("tourism");
  }

  if (name.includes("border") || type === "border_crossing") {
    tags.add("border");
    tags.add("travel");
  }

  if (tags.size === 0) tags.add("city");

  return Array.from(tags);
}

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

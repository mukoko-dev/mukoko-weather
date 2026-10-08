import { Hono } from "hono";
import type { Env } from "../types";
import {
  LOCATIONS,
  getLocationBySlug,
  getDefaultSeason,
} from "../data/locations";

const TIER_1_TAGS = new Set(["city"]);
const TIER_2_TAGS = new Set(["farming", "mining", "education", "border"]);
const TTL_TIER_1 = 1800;
const TTL_TIER_2 = 3600;
const TTL_TIER_3 = 7200;

function getTtl(_slug: string, tags: string[]): number {
  if (tags.some((t) => TIER_1_TAGS.has(t))) return TTL_TIER_1;
  if (tags.some((t) => TIER_2_TAGS.has(t))) return TTL_TIER_2;
  return TTL_TIER_3;
}

interface CachedSummary {
  insight: string;
  generatedAt: string;
  temperature: number;
  weatherCode: number;
}

/**
 * AI is served by the Python backend only (owner rule): this edge worker never
 * calls Cloudflare AI / the AI Gateway itself and holds no AI token. It asks
 * the backend's /api/py/ai (which routes through the `shamwari` gateway) and
 * caches the answer in KV, falling back to a deterministic summary.
 */
async function fetchBackendInsight(
  env: Env,
  weatherData: unknown,
  location: Record<string, unknown>,
): Promise<string | null> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (env.MUKOKO_INTERNAL_SECRET) {
      headers["X-Mukoko-Internal"] = env.MUKOKO_INTERNAL_SECRET;
    }
    const res = await fetch(`${env.NEXT_APP_URL}/api/py/ai`, {
      method: "POST",
      headers,
      body: JSON.stringify({ weatherData, location }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { insight?: string };
    return data.insight ?? null;
  } catch {
    return null;
  }
}

export const aiRoutes = new Hono<{ Bindings: Env }>();

aiRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const { weatherData, location } = body;

  if (!weatherData || !location) {
    return c.json({ error: "Missing weather data or location" }, 400);
  }

  const currentTemp = weatherData.current?.temperature_2m ?? 0;
  const currentCode = weatherData.current?.weather_code ?? 0;
  const locationSlug = ((location.name as string) ?? "unknown")
    .toLowerCase()
    .replace(/\s+/g, "-");

  const knownLocation = getLocationBySlug(locationSlug);
  const locationTags = knownLocation?.tags ?? [];
  const ttl = getTtl(locationSlug, locationTags);

  // Check KV cache
  const cacheKey = `ai-summary:${locationSlug}`;
  const cachedRaw = await c.env.AI_SUMMARIES.get(cacheKey);
  if (cachedRaw) {
    try {
      const cached: CachedSummary = JSON.parse(cachedRaw);
      const tempDelta = Math.abs(cached.temperature - currentTemp);
      const codeChanged = cached.weatherCode !== currentCode;
      if (tempDelta <= 5 && !codeChanged) {
        return c.json({
          insight: cached.insight,
          cached: true,
          generatedAt: cached.generatedAt,
        });
      }
    } catch {
      // Corrupted cache entry, regenerate
    }
  }

  const lat = location.lat ?? 0;
  const season = getDefaultSeason(new Date(), lat);

  const backendInsight = await fetchBackendInsight(c.env, weatherData, {
    name: location.name,
    elevation: location.elevation,
    lat: location.lat,
    lon: location.lon,
    country: location.country,
  });

  const temp = weatherData.current?.temperature_2m;
  const humidity = weatherData.current?.relative_humidity_2m;
  const insight =
    backendInsight ??
    `Current conditions in ${location.name}: ${temp !== undefined ? Math.round(temp) + "°C" : "N/A"} with ${humidity !== undefined ? humidity + "%" : "N/A"} humidity. Current season: ${season.name}. ${season.description}. Stay informed and plan your day accordingly.`;

  await c.env.AI_SUMMARIES.put(
    cacheKey,
    JSON.stringify({
      insight,
      generatedAt: new Date().toISOString(),
      temperature: currentTemp,
      weatherCode: currentCode,
    }),
    { expirationTtl: ttl },
  );

  return c.json({
    insight,
    cached: false,
    generatedAt: new Date().toISOString(),
  });
});

import { Hono } from "hono";
import type { Env } from "../types";

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";

const CURRENT_PARAMS = [
  "temperature_2m", "relative_humidity_2m", "apparent_temperature",
  "precipitation", "weather_code", "cloud_cover",
  "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m",
  "uv_index", "surface_pressure", "is_day",
].join(",");

const HOURLY_PARAMS = [
  "temperature_2m", "relative_humidity_2m", "precipitation_probability",
  "precipitation", "weather_code", "visibility",
  "wind_speed_10m", "uv_index", "is_day",
].join(",");

const DAILY_PARAMS = [
  "weather_code", "temperature_2m_max", "temperature_2m_min",
  "apparent_temperature_max", "apparent_temperature_min",
  "sunrise", "sunset", "uv_index_max",
  "precipitation_sum", "precipitation_probability_max",
  "wind_speed_10m_max", "wind_gusts_10m_max",
].join(",");

const WEATHER_CACHE_TTL = 900; // 15 minutes

export const weatherRoutes = new Hono<{ Bindings: Env }>();

weatherRoutes.get("/", async (c) => {
  const lat = parseFloat(c.req.query("lat") ?? "-17.83");
  const lon = parseFloat(c.req.query("lon") ?? "31.05");

  if (isNaN(lat) || isNaN(lon)) {
    return c.json({ error: "Invalid coordinates" }, 400);
  }

  // Zimbabwe bounds check
  if (lat < -23 || lat > -15 || lon < 24 || lon > 34) {
    return c.json({ error: "Coordinates outside Zimbabwe region" }, 400);
  }

  // Check KV cache first
  const cacheKey = `weather:${lat.toFixed(2)}:${lon.toFixed(2)}`;
  const cached = await c.env.WEATHER_CACHE.get(cacheKey, { type: "json" });
  if (cached) {
    return c.json(cached, 200, {
      "X-Cache": "HIT",
      "Cache-Control": `public, max-age=${WEATHER_CACHE_TTL}`,
    });
  }

  // Fetch from Open-Meteo
  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    current: CURRENT_PARAMS,
    hourly: HOURLY_PARAMS,
    daily: DAILY_PARAMS,
    timezone: "Africa/Harare",
    forecast_days: "7",
  });

  const res = await fetch(`${OPEN_METEO_BASE}?${params}`);
  if (!res.ok) {
    return c.json({ error: "Weather API error" }, 502);
  }

  const data = await res.json();

  // Cache in KV
  await c.env.WEATHER_CACHE.put(cacheKey, JSON.stringify(data), {
    expirationTtl: WEATHER_CACHE_TTL,
  });

  return c.json(data, 200, {
    "X-Cache": "MISS",
    "Cache-Control": `public, max-age=${WEATHER_CACHE_TTL}`,
  });
});

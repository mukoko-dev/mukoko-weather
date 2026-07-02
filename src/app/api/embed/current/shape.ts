/**
 * Pure helpers for the public embed API (/api/embed/current).
 *
 * Kept in a sibling module (not route.ts) because Next.js route files may only
 * export route handlers + config — arbitrary named exports are rejected at build.
 */

export const DEFAULT_SITE = "https://weather.mukoko.com";

// WMO 4677 weather-code → human label (mirrors the embed widget map).
export function weatherLabel(code: number): string {
  const map: Record<number, string> = {
    0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
    45: "Fog", 48: "Fog", 51: "Drizzle", 53: "Drizzle", 55: "Drizzle",
    56: "Freezing drizzle", 57: "Freezing drizzle",
    61: "Rain", 63: "Rain", 65: "Heavy rain",
    66: "Freezing rain", 67: "Freezing rain",
    71: "Snow", 73: "Snow", 75: "Heavy snow", 77: "Snow grains",
    80: "Showers", 81: "Showers", 82: "Violent showers",
    85: "Snow showers", 86: "Snow showers",
    95: "Thunderstorm", 96: "Thunderstorm", 99: "Thunderstorm",
  };
  return map[code] ?? "Unknown";
}

export function windDir(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8];
}

// Weather shapes we consume from /api/py/weather (only the fields we use).
export interface WeatherCurrent {
  temperature_2m?: number;
  apparent_temperature?: number;
  relative_humidity_2m?: number;
  weather_code?: number;
  wind_speed_10m?: number;
  wind_direction_10m?: number;
  is_day?: number;
}
export interface WeatherDaily {
  time?: string[];
  weather_code?: number[];
  temperature_2m_max?: number[];
  temperature_2m_min?: number[];
  precipitation_probability_max?: number[];
}
export interface WeatherResponse {
  current?: WeatherCurrent;
  daily?: WeatherDaily;
}
export interface LocationMeta {
  name: string;
  province: string;
  slug: string;
  country: string;
  lat: number;
  lon: number;
}

export type EmbedSource = "coords" | "slug" | "ip" | "fallback";

export interface EmbedResponse {
  location: LocationMeta;
  current: {
    temp: number | null;
    feelsLike: number | null;
    code: number;
    condition: string;
    high: number | null;
    low: number | null;
    humidity: number | null;
    windSpeed: number | null;
    windDirection: string | null;
    isDay: boolean;
  };
  daily: Array<{
    date: string;
    day: string;
    code: number;
    condition: string;
    high: number | null;
    low: number | null;
    precipitationProbability: number | null;
  }>;
  source: EmbedSource;
  attribution: { name: string; url: string };
}

function round(n: number | undefined | null): number | null {
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null;
}

function dayName(dateStr: string, index: number): string {
  if (index === 0) return "Today";
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-ZW", { weekday: "short" });
}

/**
 * Pure shaper — converts the internal weather + location payloads into the
 * compact public embed response.
 */
export function shapeEmbedResponse(
  weather: WeatherResponse | null,
  location: LocationMeta,
  source: EmbedSource,
  site: string = DEFAULT_SITE,
): EmbedResponse {
  const current = weather?.current ?? {};
  const daily = weather?.daily ?? {};
  const times = daily.time ?? [];

  const dailyEntries = times.slice(0, 7).map((date, i) => {
    const code = daily.weather_code?.[i] ?? 0;
    return {
      date,
      day: dayName(date, i),
      code,
      condition: weatherLabel(code),
      high: round(daily.temperature_2m_max?.[i]),
      low: round(daily.temperature_2m_min?.[i]),
      precipitationProbability: round(daily.precipitation_probability_max?.[i]),
    };
  });

  const code = current.weather_code ?? dailyEntries[0]?.code ?? 0;

  return {
    location,
    current: {
      temp: round(current.temperature_2m),
      feelsLike: round(current.apparent_temperature),
      code,
      condition: weatherLabel(code),
      high: dailyEntries[0]?.high ?? null,
      low: dailyEntries[0]?.low ?? null,
      humidity: round(current.relative_humidity_2m),
      windSpeed: round(current.wind_speed_10m),
      windDirection:
        typeof current.wind_direction_10m === "number"
          ? windDir(current.wind_direction_10m)
          : null,
      isDay: current.is_day !== 0,
    },
    daily: dailyEntries,
    source,
    attribution: {
      name: "mukoko weather",
      url: location.slug ? `${site}/${location.slug}` : site,
    },
  };
}

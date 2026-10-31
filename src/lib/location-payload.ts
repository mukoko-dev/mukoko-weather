/**
 * Server-side weather payload for a location page: the double-caught weather
 * fetch (the page shell ALWAYS renders), frost risk, and the season.
 *
 * The weather path keeps the SSR latency budget in CLAUDE.md
 * ("SSR latency budget"): `getWeatherForLocation` owns every timeout, so
 * nothing here adds one.
 */
import { cache } from "react";
import { checkFrostRisk, createFallbackWeather } from "@/lib/weather";
import type { WeatherData } from "@/lib/weather";
import { getSeasonForDate, getWeatherForLocation } from "@/lib/db";

/** Only the fields a weather fetch needs. */
export interface PayloadLocation {
  slug: string;
  lat: number;
  lon: number;
  elevation: number;
  country?: string | null;
}

export type Season = Awaited<ReturnType<typeof getSeasonForDate>>;

/**
 * Season for a country on today's date, deduplicated per request. Pages and
 * `generateMetadata` share it, so one request reads the season once.
 */
export const getCachedSeason = cache((countryCode: string, lat: number = 0) =>
  getSeasonForDate(new Date(), countryCode, lat),
);

export interface LocationWeather {
  weather: WeatherData;
  weatherSource: string;
  usingFallback: boolean;
  frostAlert: ReturnType<typeof checkFrostRisk> | null;
}

/**
 * The weather for a location, falling back to seasonal estimates when the
 * fetch throws. No frost alert is raised on a fallback.
 */
export async function loadLocationWeather(
  location: PayloadLocation,
): Promise<LocationWeather> {
  let weather: WeatherData;
  let weatherSource: string;
  try {
    const result = await getWeatherForLocation(
      location.slug,
      location.lat,
      location.lon,
      location.elevation,
    );
    weather = result.data;
    weatherSource = result.source;
  } catch {
    weather = createFallbackWeather(
      location.lat,
      location.lon,
      location.elevation,
    );
    weatherSource = "fallback";
  }

  const usingFallback = weatherSource === "fallback";
  const frostAlert = usingFallback
    ? null
    : checkFrostRisk(weather.hourly, weather.utc_offset_seconds);
  return { weather, weatherSource, usingFallback, frostAlert };
}

export interface LocationPayload extends LocationWeather {
  season: Season;
}

/**
 * Weather, frost and season for a location whose country is already known.
 * Pages that must reconcile the country against the forecast's time zone
 * (`/` and `/[location]`) use `loadLocationWeather` and their own season.
 */
export async function loadLocationPayload(
  location: PayloadLocation,
): Promise<LocationPayload> {
  const [weather, season] = await Promise.all([
    loadLocationWeather(location),
    getCachedSeason(location.country ?? "", location.lat ?? 0),
  ]);
  return { ...weather, season };
}

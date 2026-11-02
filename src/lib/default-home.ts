import { workerData } from "./worker-data";
import { fetchHomeWeather } from "./home-weather";
import type { DashboardPayload } from "./device-weather";
import { countryDisplayName } from "./location-country";
import { LOCATIONS, type WeatherLocation } from "./locations";
import {
  checkFrostRisk,
  createFallbackWeather,
  getDefaultSeason,
} from "./weather";
import { DEFAULT_HOME_SLUG, DEFAULT_PAGER_SLUGS } from "./default-places";

export { DEFAULT_HOME_SLUG, DEFAULT_PAGER_SLUGS };

/**
 * Harare, from the shipped seed: it needs no database and no network lookup,
 * so the home page can always seed it (#414).
 */
export function defaultHomeLocation(): WeatherLocation {
  const seed = LOCATIONS.find((l) => l.slug === DEFAULT_HOME_SLUG);
  if (!seed) {
    // Pinned by a test; a catalogue without Harare is a build error, not a
    // runtime case.
    throw new Error(`Seed place ${DEFAULT_HOME_SLUG} is missing`);
  }
  return seed;
}

/**
 * The dashboard payload for a home page the server could not seed in time,
 * loaded in the browser: the place this device last showed at `/` when that is
 * a shipped place (its stored copy may have expired or been wiped), else
 * Harare. Never throws: when no forecast can be had at all it is the seasonal
 * estimate, flagged, so the dashboard (and its retry) takes over instead of a
 * chooser.
 */
export async function loadDefaultHomePayload(
  rememberedSlug?: string | null,
): Promise<DashboardPayload> {
  const remembered = rememberedSlug
    ? LOCATIONS.find((l) => l.slug === rememberedSlug)
    : undefined;
  const location = remembered ?? defaultHomeLocation();
  let weather;
  let usingFallback = false;
  try {
    ({ weather, usingFallback } = await fetchHomeWeather(
      location.lat,
      location.lon,
    ));
  } catch {
    weather = createFallbackWeather(
      location.lat,
      location.lon,
      location.elevation,
    );
    usingFallback = true;
    // Do not remember the failure for the retry's sake.
    workerData.invalidate("weather", { lat: location.lat, lon: location.lon });
  }
  return {
    location,
    weather,
    usingFallback,
    frostAlert: usingFallback
      ? null
      : checkFrostRisk(weather.hourly, weather.utc_offset_seconds),
    season: getDefaultSeason(new Date(), location.lat),
    countryName: countryDisplayName(location.country),
  };
}

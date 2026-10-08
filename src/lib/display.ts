/**
 * Weather display (kiosk) helpers — the pure logic behind `/display`, the
 * full-screen page meant to run unattended on a TV, tablet or monitor.
 *
 * Kept free of React so every rule here is unit-tested directly.
 */

import type {
  AirQualityResponse,
  AqiLevel,
} from "@/components/weather/AirQualityCard";
import type { WeatherData } from "@/lib/weather";
import { MAP_LAYERS } from "@/lib/map-layers";

/** How often the display re-fetches each data source. */
export const DISPLAY_REFRESH_MS = {
  /** Forecast data: the backend caches for 15 min, so 10 min never misses a fresh row by much. */
  weather: 10 * 60 * 1000,
  /** Air quality: the backend caches for 1 h; 30 min keeps haze changes visible. */
  airQuality: 30 * 60 * 1000,
  /**
   * Full page reload. An unattended screen runs for weeks — a periodic reload
   * picks up new deploys and returns any memory the map has accumulated.
   */
  reload: 6 * 60 * 60 * 1000,
} as const;

/** Radar is the point of a wall display, so it is the default layer. */
export const DISPLAY_DEFAULT_LAYER = "precipitationIntensity";

const SLUG_RE = /^[a-z0-9-]{1,80}$/;
const LAYER_IDS = new Set(MAP_LAYERS.map((l) => l.id));

export type DisplayTheme = "light" | "dark";

export interface DisplayParams {
  /** A location slug (`?location=harare`). */
  location: string | null;
  /** A coordinate (`?lat=&lon=`), used when no slug is given. */
  coords: { lat: number; lon: number } | null;
  /** Map overlay layer id, always one of MAP_LAYERS. */
  layer: string;
  /** Forced theme, or null to follow the device. */
  theme: DisplayTheme | null;
}

type RawParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseCoord(value: string | undefined, limit: number): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return n;
}

/**
 * Parses the display's URL configuration. Everything is optional and every
 * bad value falls back to a safe default — a screen on a wall has nobody to
 * read an error message, so it must always render something.
 */
export function parseDisplayParams(raw: RawParams): DisplayParams {
  const slug = first(raw.location)?.toLowerCase();
  const lat = parseCoord(first(raw.lat), 90);
  const lon = parseCoord(first(raw.lon), 180);
  const layer = first(raw.layer);
  const theme = first(raw.theme);

  return {
    location: slug && SLUG_RE.test(slug) ? slug : null,
    coords: lat !== null && lon !== null ? { lat, lon } : null,
    layer: layer && LAYER_IDS.has(layer) ? layer : DISPLAY_DEFAULT_LAYER,
    theme: theme === "light" || theme === "dark" ? theme : null,
  };
}

/**
 * Plain-language health advice per EPA AQI band. Worded for a room full of
 * people glancing at a wall — short, actionable, no jargon. The haze bands
 * (unhealthy and above) name the concrete actions (masks, windows, purifiers).
 */
export const AQI_ADVICE: Record<AqiLevel, string> = {
  good: "Air is clean. A good time to be outside.",
  moderate:
    "Acceptable. Unusually sensitive people should take it easy outdoors.",
  unhealthy_sensitive:
    "Children, older people and anyone with asthma should limit time outdoors.",
  unhealthy:
    "Haze is unhealthy. Keep windows closed and cut outdoor exercise. Wear an N95 mask outside.",
  very_unhealthy:
    "Very unhealthy. Stay indoors, run an air purifier, and wear an N95 mask if you must go out.",
  hazardous:
    "Hazardous. Stay indoors with windows shut. Avoid all outdoor activity.",
};

/** Severity text class per AQI band, from the global severity tokens. */
export const AQI_TEXT_CLASS: Record<AqiLevel, string> = {
  good: "text-severity-low",
  moderate: "text-severity-moderate",
  unhealthy_sensitive: "text-severity-high",
  unhealthy: "text-severity-severe",
  very_unhealthy: "text-severity-extreme",
  hazardous: "text-severity-extreme",
};

/**
 * Index of the first hourly slot at or after `now` (same wall-clock rule as
 * HourlyScrollCards), or 0 when the forecast doesn't reach that far.
 */
export function currentHourIndex(times: string[], now: Date): number {
  const idx = times.findIndex((t) => {
    const d = new Date(t);
    return d.getHours() >= now.getHours() && d.getDate() === now.getDate();
  });
  return idx >= 0 ? idx : 0;
}

/** Index range of the next `count` hours, every `step` hours, starting now. */
export function nextHourIndexes(
  times: string[],
  now: Date,
  count: number,
  step = 1,
): number[] {
  const start = currentHourIndex(times, now);
  const out: number[] = [];
  for (let i = start; i < times.length && out.length < count; i += step) {
    out.push(i);
  }
  return out;
}

/**
 * Builds the shareable display URL for a location — what someone types into
 * a TV browser or bookmarks on a tablet.
 */
export function displayUrl(
  base: string,
  params: { location?: string; layer?: string; theme?: DisplayTheme },
): string {
  const url = new URL("/display", base);
  if (params.location) url.searchParams.set("location", params.location);
  if (params.layer && params.layer !== DISPLAY_DEFAULT_LAYER) {
    url.searchParams.set("layer", params.layer);
  }
  if (params.theme) url.searchParams.set("theme", params.theme);
  return url.toString();
}

/**
 * Shape guard for a `/api/py/weather` (or `/v1/weather`) response. Only the
 * fields the display reads are checked — enough that a degraded or error body
 * never replaces good data on screen.
 */
export function isDisplayWeather(json: unknown): json is WeatherData {
  if (!json || typeof json !== "object") return false;
  const w = json as Partial<WeatherData>;
  return (
    typeof w.current?.temperature_2m === "number" &&
    Array.isArray(w.hourly?.time) &&
    Array.isArray(w.daily?.time) &&
    w.daily.time.length > 0
  );
}

/** Shape guard for a `/api/py/airquality` (or `/v1/air-quality`) response. */
export function isAirQuality(json: unknown): json is AirQualityResponse {
  if (!json || typeof json !== "object") return false;
  const a = json as Partial<AirQualityResponse>;
  return (
    typeof a.aqi === "number" &&
    Number.isFinite(a.aqi) &&
    typeof a.level === "string" &&
    a.level in AQI_ADVICE
  );
}

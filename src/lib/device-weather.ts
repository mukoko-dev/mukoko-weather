/**
 * Device weather — the last good dashboard payload per place, kept on the
 * device so a repeat visit paints at once and the app still shows something
 * useful offline (issue #269).
 *
 * This module is pure: types, limits, validation, the "how old is too old"
 * rules and the eviction plan. Reading and writing IndexedDB lives in
 * `src/lib/rxdb/weather-places.ts`, which calls into these functions.
 *
 * Rules:
 * - Only real forecasts are stored, never the seasonal fallback.
 * - Up to 60 minutes old, the stored `current` block is shown as it is, with
 *   "Updated N min ago".
 * - Older than that, `current` is rebuilt from the forecast hour for "now"
 *   (in the place's own time zone) and the screen says it is a forecast.
 * - Once the stored hourly forecast no longer reaches "now", the entry is
 *   not shown at all and is deleted.
 */

import type { FrostAlert, Season, WeatherData } from "./weather";
import type { WeatherLocation } from "./locations";
import { checkFrostRisk } from "./weather";
import { isRenderableWeather } from "./home-weather";
import {
  currentWallHourMs,
  locationDateString,
  nowWallClockMs,
  wallClockLabel,
  wallClockMs,
  weatherOffsetSeconds,
} from "./location-time";

/** Everything WeatherDashboard needs for one place. */
export interface DashboardPayload {
  location: WeatherLocation;
  weather: WeatherData;
  usingFallback: boolean;
  frostAlert: FrostAlert | null;
  season: Season;
  countryName: string;
}

/** One stored place, as read back from the device. */
export interface StoredPlace {
  slug: string;
  payload: DashboardPayload;
  /** When this payload was received from the network (epoch ms). */
  fetchedAt: number;
  /** When it was last stored or shown (epoch ms) — drives LRU eviction. */
  lastAccessedAt: number;
  /** Serialised size in bytes (UTF-16 length is close enough for a budget). */
  bytes: number;
}

/** Metadata the eviction plan needs — no payload. */
export interface StoredPlaceMeta {
  slug: string;
  fetchedAt: number;
  lastAccessedAt: number;
  expiresAt: number;
  bytes: number;
}

// ---------------------------------------------------------------------------
// Budget (see the table in issue #269)
// ---------------------------------------------------------------------------

/** Current location + up to 10 saved places + 9 recently viewed. */
export const MAX_STORED_PLACES = 20;
/** Hard ceiling for all stored places together. */
export const MAX_TOTAL_BYTES = 1_000_000;
/** One place larger than this is not stored (a malformed or bloated payload). */
export const MAX_ENTRY_BYTES = 150_000;
/** Up to this age the stored `current` block is shown as current. */
export const CURRENT_MAX_AGE_MS = 60 * 60 * 1000;
/** A stored payload is refreshed in the background once it is this old. */
export const REFRESH_AFTER_MS = 15 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Serialising
// ---------------------------------------------------------------------------

/**
 * The payload as stored. The comparison series and the minutely nowcast are
 * dropped: they are large, go stale within minutes, and the dashboard fetches
 * them fresh after mount anyway.
 */
export function slimPayload(payload: DashboardPayload): DashboardPayload {
  const weather: WeatherData = { ...payload.weather };
  delete weather.models;
  delete weather.models_available;
  delete weather.models_time;
  delete weather.minutely;
  return { ...payload, weather };
}

/** The serialised record, or null when it should not be stored. */
export function serialisePayload(
  payload: DashboardPayload,
): { json: string; bytes: number } | null {
  if (payload.usingFallback) return null;
  if (!payload.location?.slug) return null;
  if (!isRenderableWeather(payload.weather)) return null;
  let json: string;
  try {
    json = JSON.stringify(slimPayload(payload));
  } catch {
    return null;
  }
  const bytes = json.length;
  if (bytes > MAX_ENTRY_BYTES) return null;
  return { json, bytes };
}

/**
 * Parse a stored record. Anything malformed — bad JSON, a missing location,
 * weather that would not render — returns null so the caller deletes it.
 */
export function parsePayload(json: unknown): DashboardPayload | null {
  if (typeof json !== "string") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<DashboardPayload>;
  const loc = p.location;
  if (
    !loc ||
    typeof loc.slug !== "string" ||
    typeof loc.name !== "string" ||
    typeof loc.lat !== "number" ||
    typeof loc.lon !== "number"
  ) {
    return null;
  }
  if (!isRenderableWeather(p.weather)) return null;
  if (!p.season || typeof p.season.name !== "string") return null;
  return {
    location: loc,
    weather: p.weather,
    usingFallback: false,
    frostAlert: p.frostAlert ?? null,
    season: p.season,
    countryName: typeof p.countryName === "string" ? p.countryName : "",
  };
}

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/**
 * The instant the stored hourly forecast runs out (epoch ms) — the end of
 * its last hour. Null when the series is empty or unreadable.
 */
export function forecastEndsAt(weather: WeatherData): number | null {
  const times = weather.hourly?.time;
  if (!times?.length) return null;
  const offset = weatherOffsetSeconds(weather);
  const lastWall = wallClockMs(times[times.length - 1], offset);
  if (lastWall === null) return null;
  return lastWall - offset * 1000 + HOUR_MS;
}

/** True while the stored hourly forecast still covers "now". */
export function forecastCoversNow(
  weather: WeatherData,
  now: number = Date.now(),
): boolean {
  const ends = forecastEndsAt(weather);
  return ends !== null && now < ends;
}

export type Freshness = "current" | "forecast";

/**
 * How a stored payload should be shown right now: as current conditions,
 * as the forecast for this hour, or (null) not at all.
 */
export function freshnessOf(
  fetchedAt: number,
  weather: WeatherData,
  now: number = Date.now(),
): Freshness | null {
  if (!Number.isFinite(fetchedAt) || fetchedAt > now + 5 * 60 * 1000) {
    // A clock jump or a corrupt timestamp: never call this "current".
    return forecastCoversNow(weather, now) ? "forecast" : null;
  }
  if (!forecastCoversNow(weather, now)) return null;
  return now - fetchedAt <= CURRENT_MAX_AGE_MS ? "current" : "forecast";
}

/**
 * The weather re-based on "now" in the place's own time zone: hourly starts
 * at the current hour, daily starts today, and — for a `forecast` view —
 * `current` is the forecast for this hour. The minutely nowcast is never
 * carried over. Returns the input unchanged when nothing needs trimming.
 */
export function rebaseWeather(
  weather: WeatherData,
  freshness: Freshness,
  now: number = Date.now(),
): WeatherData {
  const nowDate = new Date(now);
  const offset = weatherOffsetSeconds(weather, nowDate);
  const hourStart = currentWallHourMs(offset, nowDate);
  const hourly = weather.hourly;
  let hi = hourly.time.findIndex((t) => {
    const k = wallClockMs(t, offset);
    return k !== null && k >= hourStart;
  });
  if (hi < 0) hi = 0;

  const today = locationDateString(offset, nowDate);
  let di = weather.daily.time.findIndex((d) => d.slice(0, 10) >= today);
  if (di < 0) di = Math.max(0, weather.daily.time.length - 1);

  const sliceAll = <T extends object>(obj: T, from: number): T => {
    if (from === 0) return obj;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = Array.isArray(v) ? v.slice(from) : v;
    }
    return out as T;
  };

  const rebased: WeatherData = {
    ...weather,
    hourly: sliceAll(hourly, hi),
    daily: sliceAll(weather.daily, di),
  };
  delete rebased.minutely;

  if (freshness === "forecast") {
    const h = rebased.hourly;
    const at = <K extends keyof typeof h>(key: K, fallback: number): number => {
      const series = h[key] as unknown;
      const v = Array.isArray(series) ? series[0] : undefined;
      return typeof v === "number" && Number.isFinite(v) ? v : fallback;
    };
    const c = weather.current;
    rebased.current = {
      ...c,
      temperature_2m: at("temperature_2m", c.temperature_2m),
      apparent_temperature: at("apparent_temperature", c.apparent_temperature),
      relative_humidity_2m: at("relative_humidity_2m", c.relative_humidity_2m),
      precipitation: at("precipitation", c.precipitation),
      weather_code: at("weather_code", c.weather_code),
      cloud_cover: at("cloud_cover", c.cloud_cover),
      wind_speed_10m: at("wind_speed_10m", c.wind_speed_10m),
      wind_direction_10m: at("wind_direction_10m", c.wind_direction_10m),
      wind_gusts_10m: at("wind_gusts_10m", c.wind_gusts_10m),
      uv_index: at("uv_index", c.uv_index),
      surface_pressure: at("surface_pressure", c.surface_pressure),
      is_day: at("is_day", c.is_day),
    };
  }
  return rebased;
}

/** A stored place ready to render, or null when it is too old to show. */
export interface DeviceView {
  payload: DashboardPayload;
  freshness: Freshness;
  fetchedAt: number;
}

export function deviceViewOf(
  stored: Pick<StoredPlace, "payload" | "fetchedAt">,
  now: number = Date.now(),
): DeviceView | null {
  const freshness = freshnessOf(stored.fetchedAt, stored.payload.weather, now);
  if (!freshness) return null;
  const weather = rebaseWeather(stored.payload.weather, freshness, now);
  return {
    freshness,
    fetchedAt: stored.fetchedAt,
    payload: {
      ...stored.payload,
      weather,
      // Frost risk is about the hours ahead, so it follows the rebased series.
      frostAlert: checkFrostRisk(weather.hourly, weather.utc_offset_seconds),
    },
  };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** "Updated just now" / "Updated 12 min ago" / "Updated 3 h ago" / "Updated 2 days ago". */
export function updatedAgoLabel(
  fetchedAt: number,
  now: number = Date.now(),
): string {
  const ms = Math.max(0, now - fetchedAt);
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "Updated just now";
  if (min < 60) return `Updated ${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `Updated ${h} h ago`;
  return `Updated ${Math.floor(h / 24)} days ago`;
}

/** The place's own clock right now, "HH:MM". */
export function placeClockLabel(
  weather: WeatherData,
  now: number = Date.now(),
): string {
  const nowDate = new Date(now);
  return wallClockLabel(
    nowWallClockMs(weatherOffsetSeconds(weather, nowDate), nowDate),
  );
}

/** The location slug for a `/{slug}` path, else null (sub-routes excluded). */
export function slugFromLocationPath(pathname: string | null): string | null {
  const parts = (pathname ?? "").split("/").filter(Boolean);
  if (parts.length !== 1) return null;
  try {
    return decodeURIComponent(parts[0]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

/**
 * Which stored places to delete. Expired ones always go. Pinned places (the
 * current location and saved places) are never evicted for space; the rest
 * go least-recently-used first until both the count and the byte budget fit.
 */
export function planEviction(
  entries: readonly StoredPlaceMeta[],
  pinned: ReadonlySet<string>,
  now: number = Date.now(),
  limits: { maxPlaces: number; maxBytes: number } = {
    maxPlaces: MAX_STORED_PLACES,
    maxBytes: MAX_TOTAL_BYTES,
  },
): string[] {
  const remove = new Set<string>();
  const live: StoredPlaceMeta[] = [];
  for (const e of entries) {
    if (!Number.isFinite(e.expiresAt) || e.expiresAt <= now) remove.add(e.slug);
    else live.push(e);
  }

  let count = live.length;
  let bytes = live.reduce((sum, e) => sum + (e.bytes || 0), 0);
  const candidates = live
    .filter((e) => !pinned.has(e.slug))
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  for (const e of candidates) {
    if (count <= limits.maxPlaces && bytes <= limits.maxBytes) break;
    remove.add(e.slug);
    count -= 1;
    bytes -= e.bytes || 0;
  }
  return [...remove];
}

/** True for a storage-full error from IndexedDB / Dexie / RxDB. */
export function isQuotaError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === "string") return /quota/i.test(err);
  if (typeof err !== "object") return false;
  const { name, message } = err as { name?: unknown; message?: unknown };
  return [name, message].some((v) => typeof v === "string" && /quota/i.test(v));
}

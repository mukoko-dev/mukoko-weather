/* Open-Meteo weather API client */

import {
  currentHourIndex,
  currentWallHourMs,
  locationHourOf,
  longitudeOffsetSeconds,
  nowWallClockMs,
  resolveOffsetSeconds,
  wallNaiveIso,
  weatherOffsetSeconds,
} from "./location-time";
import {
  CONVECTIVE_WINDOW_H,
  GDD_DEFINITIONS,
  cloudBaseKm,
  convectiveProxy,
  dewPointC,
  growingDegreeDays,
  heatIndexC,
  moonPhase,
} from "./derived-insights";

export interface CurrentWeather {
  temperature_2m: number;
  relative_humidity_2m: number;
  apparent_temperature: number;
  precipitation: number;
  weather_code: number;
  cloud_cover: number;
  wind_speed_10m: number;
  wind_direction_10m: number;
  wind_gusts_10m: number;
  uv_index: number;
  surface_pressure: number;
  is_day: number;
}

export interface HourlyWeather {
  time: string[];
  temperature_2m: number[];
  apparent_temperature: number[];
  relative_humidity_2m: number[];
  precipitation_probability: number[];
  precipitation: number[];
  weather_code: number[];
  visibility: number[];
  cloud_cover: number[];
  surface_pressure: number[];
  wind_speed_10m: number[];
  wind_direction_10m: number[];
  wind_gusts_10m: number[];
  uv_index: number[];
  is_day: number[];
  /** Intermediate insight inputs — only on the TS direct-Open-Meteo path. */
  dew_point_2m?: (number | null)[];
  cape?: (number | null)[];
  lifted_index?: (number | null)[];
}

export interface DailyWeather {
  time: string[];
  weather_code: number[];
  temperature_2m_max: number[];
  temperature_2m_min: number[];
  apparent_temperature_max: number[];
  apparent_temperature_min: number[];
  sunrise: string[];
  sunset: string[];
  uv_index_max: number[];
  precipitation_sum: number[];
  precipitation_probability_max: number[];
  wind_speed_10m_max: number[];
  wind_gusts_10m_max: number[];
  /** FAO reference evapotranspiration (mm/day) — TS direct path only. */
  et0_fao_evapotranspiration?: (number | null)[];
}

export interface WeatherData {
  current: CurrentWeather;
  hourly: HourlyWeather;
  daily: DailyWeather;
  current_units: Record<string, string>;
  /**
   * Activity-specific insights. `/api/py/weather` always derives them from the
   * model baseline (issue #246) and merges Tomorrow.io enrichment on top when
   * its budget allows; the TS direct-Open-Meteo path uses
   * `synthesizeOpenMeteoInsights`.
   */
  insights?: WeatherInsights;
  /** Next-hour precipitation nowcast (4 × 15-min steps) from Open-Meteo */
  minutely?: MinutelyData;
  /** Per-model hourly temperature/precip comparison series (Windy-style) */
  models?: ModelForecast[];
  /** Model ids that returned usable data (subset of the requested set) */
  models_available?: string[];
  /** Shared hourly time axis (ISO 8601) for the per-model comparison series */
  models_time?: string[];
  /**
   * The LOCATION's UTC offset in seconds (Open-Meteo `utc_offset_seconds`).
   * `/api/py/weather` always sets it (provider value, else a longitude
   * estimate). Every "current hour" and hour label must read the forecast in
   * this offset — see `src/lib/location-time.ts` — never the viewer's clock.
   */
  utc_offset_seconds?: number;
  /** True when `utc_offset_seconds` is a longitude estimate, not a tz lookup. */
  utc_offset_estimated?: boolean;
}

/**
 * Global forecast models (Open-Meteo ids, checked live 2026-10-10 — issue #246).
 *
 * `best_match` is the stored default preference and now means the server's
 * Africa-weighted multi-model BLEND (ECMWF IFS + AIFS heaviest, then GFS,
 * ICON, GEM, ARPEGE — `api/py/_model_blend.py`). Picking any other model
 * makes that single model the baseline.
 */
export enum ForecastModel {
  BestMatch = "best_match",
  ECMWF = "ecmwf_ifs",
  AIFS = "ecmwf_aifs025_single",
  GFS = "gfs_seamless",
  ICON = "icon_global",
  MeteoFrance = "meteofrance_seamless",
}

/** Human-readable labels for each forecast model (short national/agency names). */
export const FORECAST_MODEL_LABELS: Record<ForecastModel, string> = {
  [ForecastModel.BestMatch]: "Mukoko blend (recommended)",
  [ForecastModel.ECMWF]: "ECMWF IFS (Europe)",
  [ForecastModel.AIFS]: "ECMWF AIFS (AI model)",
  [ForecastModel.GFS]: "GFS (NOAA, USA)",
  [ForecastModel.ICON]: "ICON (DWD, Germany)",
  [ForecastModel.MeteoFrance]: "Météo-France",
};

/**
 * Retired / renamed model ids → current id. `ecmwf_ifs04` is dead upstream
 * (all-null series); stored preferences are mapped instead of breaking.
 */
const LEGACY_MODEL_IDS: Record<string, ForecastModel> = {
  ecmwf_ifs04: ForecastModel.ECMWF,
  icon_seamless: ForecastModel.ICON,
};

/** A stored model preference in its current form (unknown → best_match). */
export function normalizeForecastModel(
  model: string | null | undefined,
): ForecastModel {
  const m = (model ?? "").trim();
  if (m in LEGACY_MODEL_IDS) return LEGACY_MODEL_IDS[m];
  return (Object.values(ForecastModel) as string[]).includes(m)
    ? (m as ForecastModel)
    : ForecastModel.BestMatch;
}

/** The comparison set overlaid on the ModelComparisonChart — the blend's core members. */
export const COMPARISON_MODELS: ForecastModel[] = [
  ForecastModel.ECMWF,
  ForecastModel.AIFS,
  ForecastModel.GFS,
  ForecastModel.ICON,
];

/** Next-hour precipitation nowcast — 15-minute steps. */
export interface MinutelyData {
  time: string[];
  precipitation: number[];
}

/** A single model's hourly temperature/precipitation series. */
export interface ModelForecast {
  model: string;
  temperature_2m: (number | null)[];
  precipitation: (number | null)[];
}

/** Extended weather data from Tomorrow.io for activity-aware insight cards */
export interface WeatherInsights {
  // Farming — Growing Degree Days (today)
  gdd10To30?: number; // Maize & soybean
  gdd10To31?: number; // Sunflower
  gdd08To30?: number; // Sorghum & green gram
  gdd03To25?: number; // Potatoes
  evapotranspiration?: number; // mm (today)
  dewPoint?: number; // °C (current)
  precipitationType?: number; // 0=none, 1=rain, 2=snow, 3=freezing rain, 4=sleet

  // Wind — drone flying, outdoor safety
  windSpeed?: number; // km/h (current)
  windGust?: number; // km/h (current)

  // Safety — outdoor activities
  thunderstormProbability?: number; // % (current)
  heatStressIndex?: number; // 0–30+ (current)
  uvHealthConcern?: number; // 0–11+ (current)

  // Tourism / photography
  moonPhase?: number; // 0–7
  cloudBase?: number | null; // km (current)
  cloudCeiling?: number | null; // km (current)
  visibility?: number; // km (current)
}

/**
 * Thunderstorm probability and precipitation type implied by a WMO 4677 code.
 * Shared by the current-conditions fallback (synthesizeOpenMeteoInsights) and
 * the per-hour feasibility series (activity-feasibility hourInsights) so the
 * two can never disagree about what a code means.
 *
 * - Thunderstorm: 95–99 graduated by severity (95 = 70, 96/97 = 85, 99 = 95).
 * - precipitationType: 0=none, 1=rain, 2=snow, 3=freezing rain/drizzle, 4=ice pellets.
 */
export function wmoToInsightHazards(code: number): {
  thunderstormProbability: number;
  precipitationType: number;
} {
  let thunderstormProbability = 0;
  if (code >= 99) thunderstormProbability = 95;
  else if (code >= 96) thunderstormProbability = 85;
  else if (code >= 95) thunderstormProbability = 70;

  let precipitationType = 0;
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86))
    precipitationType = 2; // Snow + snow showers
  else if (code === 66 || code === 67 || code === 56 || code === 57)
    precipitationType = 3; // Freezing rain + freezing drizzle
  else if (code >= 51) precipitationType = 1; // Rain/drizzle/thunderstorm

  return { thunderstormProbability, precipitationType };
}

/**
 * Derive the full WeatherInsights set from model data — no Tomorrow.io.
 *
 * Mirror of `derive_insights` in `api/py/_insights.py` (issue #246): wind,
 * visibility (metres → km, the unit the suitability thresholds use), dew
 * point (model value or Magnus), heat index, UV, precipitation type, a
 * thunderstorm proxy (WMO codes + CAPE/lifted index over the next 6 h,
 * halved without rain agreement), GDD from today's max/min, ET₀, moon phase
 * and cloud base/ceiling. Fields that cannot be derived are omitted, which
 * the rules engine already treats as "no match".
 */
export function synthesizeOpenMeteoInsights(
  data: WeatherData,
  now: Date = new Date(),
): WeatherInsights {
  const current = data.current;
  const hourly = data.hourly;
  // The location's current hour — read in its own time zone, not the
  // viewer's or the server's (see location-time.ts).
  const idx = Math.max(
    0,
    currentHourIndex(hourly?.time, weatherOffsetSeconds(data)),
  );
  const at = (arr: (number | null)[] | undefined, i: number) => {
    const v = arr?.[i];
    return typeof v === "number" ? v : undefined;
  };

  const out: WeatherInsights = {};
  if (current.wind_speed_10m != null) out.windSpeed = current.wind_speed_10m;
  if (current.wind_gusts_10m != null) out.windGust = current.wind_gusts_10m;

  const visM = at(hourly?.visibility, idx);
  if (visM !== undefined) out.visibility = Math.round(visM / 10) / 100;

  const dew =
    at(hourly?.dew_point_2m, idx) ??
    dewPointC(current.temperature_2m, current.relative_humidity_2m);
  if (dew !== undefined) out.dewPoint = dew;

  const heat = heatIndexC(current.temperature_2m, current.relative_humidity_2m);
  if (heat !== undefined) out.heatStressIndex = heat;

  const uv = current.uv_index ?? at(hourly?.uv_index, idx);
  if (uv != null) out.uvHealthConcern = uv;

  const hazards = wmoToInsightHazards(current.weather_code);
  const precipitationType = hazards.precipitationType;
  let thunderstormProbability = hazards.thunderstormProbability;
  out.precipitationType = precipitationType;

  let convective = 0;
  let maxPp = 0;
  const hasPp = (hourly?.precipitation_probability?.length ?? 0) > 0;
  for (let i = idx; i < idx + CONVECTIVE_WINDOW_H; i++) {
    convective = Math.max(
      convective,
      convectiveProxy(at(hourly?.cape, i), at(hourly?.lifted_index, i)),
    );
    const code = at(hourly?.weather_code, i);
    if (code !== undefined) {
      thunderstormProbability = Math.max(
        thunderstormProbability,
        wmoToInsightHazards(code).thunderstormProbability,
      );
    }
    maxPp = Math.max(maxPp, at(hourly?.precipitation_probability, i) ?? 0);
  }
  if (hasPp && maxPp < 20) convective = Math.floor(convective / 2);
  out.thunderstormProbability = Math.max(thunderstormProbability, convective);

  const tmax = at(data.daily?.temperature_2m_max, 0);
  const tmin = at(data.daily?.temperature_2m_min, 0);
  for (const [key, base, cap] of GDD_DEFINITIONS) {
    const gdd = growingDegreeDays(tmax, tmin, base, cap);
    if (gdd !== undefined) out[key] = gdd;
  }

  const et0 = at(data.daily?.et0_fao_evapotranspiration, 0);
  if (et0 !== undefined) out.evapotranspiration = et0;

  out.moonPhase = moonPhase(now);

  const base = cloudBaseKm(current.temperature_2m, dew, current.cloud_cover);
  if (base !== undefined) {
    out.cloudBase = base;
    out.cloudCeiling = current.cloud_cover >= 50 ? base : null;
  }
  return out;
}

export interface FrostAlert {
  risk: "severe" | "high" | "moderate";
  lowestTemp: number;
  startTime: string;
  endTime: string;
  message: string;
}

const CURRENT_PARAMS = [
  "temperature_2m",
  "relative_humidity_2m",
  "apparent_temperature",
  "precipitation",
  "weather_code",
  "cloud_cover",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "uv_index",
  "surface_pressure",
  "is_day",
].join(",");

const HOURLY_PARAMS = [
  "temperature_2m",
  "apparent_temperature",
  "relative_humidity_2m",
  "precipitation_probability",
  "precipitation",
  "weather_code",
  "visibility",
  "cloud_cover",
  "surface_pressure",
  "wind_speed_10m",
  "wind_direction_10m",
  "wind_gusts_10m",
  "uv_index",
  "is_day",
  // Insight inputs (synthesizeOpenMeteoInsights). The TS path never writes
  // the cache, so the extra arrays never reach a stored document.
  "dew_point_2m",
  "cape",
  "lifted_index",
].join(",");

const DAILY_PARAMS = [
  "weather_code",
  "temperature_2m_max",
  "temperature_2m_min",
  "apparent_temperature_max",
  "apparent_temperature_min",
  "sunrise",
  "sunset",
  "uv_index_max",
  "precipitation_sum",
  "precipitation_probability_max",
  "wind_speed_10m_max",
  "wind_gusts_10m_max",
  "et0_fao_evapotranspiration",
].join(",");

export async function fetchWeather(
  lat: number,
  lon: number,
  models?: string[],
): Promise<WeatherData> {
  // Only forward real model ids to Open-Meteo — `best_match` is the unsuffixed
  // baseline the API always returns, so it isn't sent as an explicit model.
  const requestedModels = (models ?? []).filter(
    (m) => m && m !== ForecastModel.BestMatch,
  );

  const params = new URLSearchParams({
    latitude: lat.toString(),
    longitude: lon.toString(),
    current: CURRENT_PARAMS,
    hourly: HOURLY_PARAMS,
    daily: DAILY_PARAMS,
    // Next-hour precipitation nowcast (4 × 15-min steps).
    minutely_15: "precipitation",
    forecast_minutely_15: "4",
    timezone: "auto",
    forecast_days: "7",
  });
  if (requestedModels.length > 0) {
    params.set("models", requestedModels.join(","));
  }

  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
    next: { revalidate: 900 }, // cache for 15 minutes
    signal: AbortSignal.timeout(10_000), // 10s timeout
  });

  if (!res.ok) {
    throw new Error(`Weather API error: ${res.status}`);
  }

  const raw = await res.json();
  return normalizeMultiModel(raw, requestedModels);
}

/**
 * Parse Open-Meteo's `minutely_15` block into the next-hour nowcast shape.
 * Returns `undefined` when the API returned no minutely data.
 */
export function parseMinutely(raw: {
  minutely_15?: { time?: string[]; precipitation?: (number | null)[] };
}): MinutelyData | undefined {
  const m = raw.minutely_15;
  if (!m?.time?.length) return undefined;
  return {
    time: m.time.slice(0, 4),
    precipitation: (m.precipitation ?? []).slice(0, 4).map((p) => p ?? 0),
  };
}

/**
 * Build per-model hourly temperature/precip series from an Open-Meteo hourly
 * block. Open-Meteo suffixes fields per model (`temperature_2m_ecmwf_ifs04`),
 * falling back to the unsuffixed `temperature_2m` (best_match) key. A model is
 * "available" when it has at least one non-null temperature reading.
 */
export function parseModelSeries(
  raw: { hourly?: Record<string, unknown> },
  models: string[],
): {
  models: ModelForecast[];
  models_available: string[];
  models_time: string[];
} {
  const hourly = raw.hourly ?? {};
  const baseTemp = (hourly["temperature_2m"] as (number | null)[]) ?? [];
  const basePrecip = (hourly["precipitation"] as (number | null)[]) ?? [];
  const time = ((hourly["time"] as string[]) ?? []).slice(0, 24);

  const series: ModelForecast[] = [];
  const available: string[] = [];
  for (const model of models) {
    const temp =
      (hourly[`temperature_2m_${model}`] as (number | null)[]) ?? baseTemp;
    const precip =
      (hourly[`precipitation_${model}`] as (number | null)[]) ?? basePrecip;
    if (temp.some((v) => v !== null && v !== undefined)) {
      series.push({
        model,
        temperature_2m: temp.slice(0, 24),
        precipitation: (precip ?? []).slice(0, 24),
      });
      available.push(model);
    }
  }
  return { models: series, models_available: available, models_time: time };
}

/**
 * Merge Open-Meteo's raw multi-model/minutely fields into the WeatherData
 * shape. When no models were requested, the base fields are returned as-is
 * plus the minutely nowcast (which is always requested).
 */
export function normalizeMultiModel(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any,
  models: string[],
): WeatherData {
  const data = raw as WeatherData;
  data.minutely = parseMinutely(raw);
  if (models.length > 0) {
    const parsed = parseModelSeries(raw, models);
    data.models = parsed.models;
    data.models_available = parsed.models_available;
    data.models_time = parsed.models_time;
  }
  return data;
}

/**
 * Frost risk: any hour at or below 3°C between 22:00 and 08:00 at the
 * LOCATION (pass the payload's `utc_offset_seconds`; zoned Tomorrow.io
 * instants would otherwise be read in the server's UTC clock).
 */
export function checkFrostRisk(
  hourly: HourlyWeather,
  offsetSeconds?: number | null,
): FrostAlert | null {
  const offset = resolveOffsetSeconds(offsetSeconds);
  const frostHours = hourly.temperature_2m
    .map((temp, i) => ({ temp, time: hourly.time[i] }))
    .filter((h) => {
      const hour = locationHourOf(h.time, offset);
      return hour !== null && (hour >= 22 || hour <= 8) && h.temp <= 3;
    });

  if (frostHours.length > 0) {
    const lowestTemp = Math.min(...frostHours.map((h) => h.temp));
    return {
      risk: lowestTemp <= 0 ? "severe" : lowestTemp <= 2 ? "high" : "moderate",
      lowestTemp,
      startTime: frostHours[0].time,
      endTime: frostHours[frostHours.length - 1].time,
      message:
        lowestTemp <= 0
          ? `Severe frost warning: ${lowestTemp}°C expected. Protect all crops immediately.`
          : `Frost risk tonight: temperatures dropping to ${lowestTemp}°C. Cover sensitive plants.`,
    };
  }
  return null;
}

/** WMO Weather interpretation codes → label & icon */
export function weatherCodeToInfo(code: number): {
  label: string;
  icon: string;
} {
  const map: Record<number, { label: string; icon: string }> = {
    0: { label: "Clear sky", icon: "sun" },
    1: { label: "Mainly clear", icon: "sun" },
    2: { label: "Partly cloudy", icon: "cloud-sun" },
    3: { label: "Overcast", icon: "cloud" },
    45: { label: "Fog", icon: "cloud-fog" },
    48: { label: "Depositing rime fog", icon: "cloud-fog" },
    51: { label: "Light drizzle", icon: "cloud-drizzle" },
    56: { label: "Light freezing drizzle", icon: "cloud-hail" },
    57: { label: "Dense freezing drizzle", icon: "cloud-hail" },
    53: { label: "Moderate drizzle", icon: "cloud-drizzle" },
    55: { label: "Dense drizzle", icon: "cloud-drizzle" },
    61: { label: "Slight rain", icon: "cloud-rain" },
    63: { label: "Moderate rain", icon: "cloud-rain" },
    65: { label: "Heavy rain", icon: "cloud-rain" },
    66: { label: "Light freezing rain", icon: "cloud-hail" },
    67: { label: "Heavy freezing rain", icon: "cloud-hail" },
    71: { label: "Slight snow", icon: "snowflake" },
    73: { label: "Moderate snow", icon: "snowflake" },
    75: { label: "Heavy snow", icon: "snowflake" },
    77: { label: "Snow grains", icon: "snowflake" },
    80: { label: "Slight rain showers", icon: "cloud-sun-rain" },
    81: { label: "Moderate rain showers", icon: "cloud-rain" },
    82: { label: "Violent rain showers", icon: "cloud-rain" },
    85: { label: "Slight snow showers", icon: "snowflake" },
    86: { label: "Heavy snow showers", icon: "snowflake" },
    95: { label: "Thunderstorm", icon: "cloud-lightning" },
    96: { label: "Thunderstorm with slight hail", icon: "cloud-lightning" },
    99: { label: "Thunderstorm with heavy hail", icon: "cloud-lightning" },
  };
  return map[code] ?? { label: "Unknown", icon: "cloud" };
}

/** Season info (name, local name, description) */
export interface Season {
  name: string;
  localName: string;
  description: string;
}

/** @deprecated Use Season instead */
export type ZimbabweSeason = Season;

/** Default hemisphere-aware season fallback (used when DB has no season data for the location's country) */
export function getDefaultSeason(
  date: Date = new Date(),
  lat: number = 0,
): Season {
  const month = date.getMonth() + 1; // 1-12
  const southern = lat < 0;

  if (southern) {
    if (month === 12 || month <= 2)
      return {
        name: "Summer",
        localName: "Summer",
        description: "Warm season with possible thunderstorms",
      };
    if (month >= 3 && month <= 5)
      return {
        name: "Autumn",
        localName: "Autumn",
        description: "Cooling temperatures, harvest period",
      };
    if (month >= 6 && month <= 8)
      return {
        name: "Winter",
        localName: "Winter",
        description: "Cool and dry with possible frost",
      };
    return {
      name: "Spring",
      localName: "Spring",
      description: "Warming temperatures, early rains possible",
    };
  }

  if (month >= 3 && month <= 5)
    return {
      name: "Spring",
      localName: "Spring",
      description: "Warming temperatures, new growth",
    };
  if (month >= 6 && month <= 8)
    return {
      name: "Summer",
      localName: "Summer",
      description: "Warmest season with longer days",
    };
  if (month >= 9 && month <= 11)
    return {
      name: "Autumn",
      localName: "Autumn",
      description: "Cooling temperatures, shorter days",
    };
  return {
    name: "Winter",
    localName: "Winter",
    description: "Coldest season with shorter days",
  };
}

/**
 * @deprecated Use getDefaultSeason instead.
 * Wraps getDefaultSeason with lat=-17 (southern hemisphere) to preserve
 * backward-compatible Zimbabwe seasonal behavior for un-migrated callers.
 */
export function getZimbabweSeason(date: Date = new Date()): Season {
  return getDefaultSeason(date, -17);
}

const COMPASS_16 = [
  "N",
  "NNE",
  "NE",
  "ENE",
  "E",
  "ESE",
  "SE",
  "SSE",
  "S",
  "SSW",
  "SW",
  "WSW",
  "W",
  "WNW",
  "NW",
  "NNW",
];

/**
 * Compass label for a bearing in degrees. 16 points by default; `points: 8`
 * returns the cardinal/intercardinal subset (N, NE, E, … NW).
 */
export function windDirection(
  degrees: number,
  { points = 16 }: { points?: 8 | 16 } = {},
): string {
  if (points === 8) return COMPASS_16[(Math.round(degrees / 45) % 8) * 2];
  return COMPASS_16[Math.round(degrees / 22.5) % 16];
}

export function uvLevel(index: number): { label: string; color: string } {
  if (index <= 2) return { label: "Low", color: "text-success" };
  if (index <= 5) return { label: "Moderate", color: "text-warmth" };
  if (index <= 7) return { label: "High", color: "text-accent" };
  if (index <= 10) return { label: "Very High", color: "text-earth" };
  return { label: "Extreme", color: "text-primary" };
}

/**
 * Generate fallback weather data using hemisphere-aware seasonal averages (elevation-adjusted).
 * Used when all weather providers are unavailable so the page still renders.
 * Temperatures are adjusted for elevation (~6.5°C per 1000m lapse rate).
 */
export function createFallbackWeather(
  lat: number,
  lon: number,
  elevation: number,
): WeatherData {
  const now = new Date();
  const season = getDefaultSeason(now, lat);
  // No provider answered, so estimate the location's offset from longitude
  // and build the series on ITS wall clock (naive local strings, like
  // Open-Meteo) — never the server's or the viewer's.
  const offset = longitudeOffsetSeconds(lon);
  const hour = new Date(nowWallClockMs(offset, now)).getUTCHours();
  const isDay = hour >= 6 && hour < 18 ? 1 : 0;
  const firstHourWall = currentWallHourMs(offset, now);

  // Seasonal base temperatures (°C) at ~1200m reference elevation
  const seasonalBase: Record<
    string,
    { high: number; low: number; humidity: number; code: number }
  > = {
    Summer: { high: 30, low: 18, humidity: 65, code: 2 },
    Autumn: { high: 24, low: 12, humidity: 55, code: 2 },
    Winter: { high: 18, low: 5, humidity: 40, code: 0 },
    Spring: { high: 24, low: 12, humidity: 50, code: 2 },
  };
  const base = seasonalBase[season.name] ?? seasonalBase["Summer"];

  // Adjust for elevation: −6.5°C per 1000m above reference (1200m)
  const elevAdj = ((elevation - 1200) / 1000) * -6.5;
  const high = Math.round(base.high + elevAdj);
  const low = Math.round(base.low + elevAdj);
  const midTemp = Math.round((high + low) / 2);

  // Generate 48 hours of hourly data
  const hourlyTimes: string[] = [];
  const hourlyTemps: number[] = [];
  const hourlyApparent: number[] = [];
  const hourlyHumidity: number[] = [];
  const hourlyPrecipProb: number[] = [];
  const hourlyPrecip: number[] = [];
  const hourlyCodes: number[] = [];
  const hourlyVis: number[] = [];
  const hourlyCloud: number[] = [];
  const hourlyPressure: number[] = [];
  const hourlyWindSpeed: number[] = [];
  const hourlyWindDir: number[] = [];
  const hourlyWindGusts: number[] = [];
  const hourlyUV: number[] = [];
  const hourlyIsDay: number[] = [];

  for (let i = 0; i < 48; i++) {
    const wall = firstHourWall + i * 3600_000;
    const h = new Date(wall).getUTCHours();
    const daylight = h >= 6 && h < 18;
    // Sinusoidal temperature curve: low at 5am, high at 2pm
    const tempFrac = Math.sin(((h - 5) / 24) * Math.PI);
    const temp = Math.round(low + (high - low) * Math.max(0, tempFrac));

    hourlyTimes.push(wallNaiveIso(wall));
    hourlyTemps.push(temp);
    hourlyApparent.push(temp - 1);
    hourlyHumidity.push(base.humidity);
    hourlyPrecipProb.push(0);
    hourlyPrecip.push(0);
    hourlyCodes.push(base.code);
    hourlyVis.push(10000);
    hourlyCloud.push(base.code === 0 ? 10 : 40);
    hourlyPressure.push(870);
    hourlyWindSpeed.push(8);
    hourlyWindDir.push(90);
    hourlyWindGusts.push(15);
    hourlyUV.push(daylight ? 5 : 0);
    hourlyIsDay.push(daylight ? 1 : 0);
  }

  // Generate 7 days of daily data
  const dailyTimes: string[] = [];
  const dailyHighs: number[] = [];
  const dailyLows: number[] = [];
  const dailyApparentHighs: number[] = [];
  const dailyApparentLows: number[] = [];
  const dailyCodes: number[] = [];
  const dailySunrise: string[] = [];
  const dailySunset: string[] = [];
  const dailyUV: number[] = [];
  const dailyPrecipSum: number[] = [];
  const dailyPrecipProbMax: number[] = [];
  const dailyWindMax: number[] = [];
  const dailyGustMax: number[] = [];

  for (let d = 0; d < 7; d++) {
    const dayWall =
      Math.floor(firstHourWall / 86_400_000) * 86_400_000 + d * 86_400_000;
    const date = wallNaiveIso(dayWall).slice(0, 10);

    dailyTimes.push(date);
    dailyHighs.push(high);
    dailyLows.push(low);
    dailyApparentHighs.push(high - 1);
    dailyApparentLows.push(low - 1);
    dailyCodes.push(base.code);
    dailySunrise.push(`${date}T05:45`);
    dailySunset.push(`${date}T18:15`);
    dailyUV.push(7);
    dailyPrecipSum.push(0);
    dailyPrecipProbMax.push(0);
    dailyWindMax.push(12);
    dailyGustMax.push(20);
  }

  return {
    current: {
      temperature_2m: midTemp,
      relative_humidity_2m: base.humidity,
      apparent_temperature: midTemp - 1,
      precipitation: 0,
      weather_code: base.code,
      cloud_cover: base.code === 0 ? 10 : 40,
      wind_speed_10m: 8,
      wind_direction_10m: 90,
      wind_gusts_10m: 15,
      uv_index: isDay ? 5 : 0,
      surface_pressure: 870,
      is_day: isDay,
    },
    hourly: {
      time: hourlyTimes,
      temperature_2m: hourlyTemps,
      apparent_temperature: hourlyApparent,
      relative_humidity_2m: hourlyHumidity,
      precipitation_probability: hourlyPrecipProb,
      precipitation: hourlyPrecip,
      weather_code: hourlyCodes,
      visibility: hourlyVis,
      cloud_cover: hourlyCloud,
      surface_pressure: hourlyPressure,
      wind_speed_10m: hourlyWindSpeed,
      wind_direction_10m: hourlyWindDir,
      wind_gusts_10m: hourlyWindGusts,
      uv_index: hourlyUV,
      is_day: hourlyIsDay,
    },
    daily: {
      time: dailyTimes,
      weather_code: dailyCodes,
      temperature_2m_max: dailyHighs,
      temperature_2m_min: dailyLows,
      apparent_temperature_max: dailyApparentHighs,
      apparent_temperature_min: dailyApparentLows,
      sunrise: dailySunrise,
      sunset: dailySunset,
      uv_index_max: dailyUV,
      precipitation_sum: dailyPrecipSum,
      precipitation_probability_max: dailyPrecipProbMax,
      wind_speed_10m_max: dailyWindMax,
      wind_gusts_10m_max: dailyGustMax,
    },
    current_units: {
      temperature_2m: "°C",
      relative_humidity_2m: "%",
      apparent_temperature: "°C",
      precipitation: "mm",
      wind_speed_10m: "km/h",
      wind_gusts_10m: "km/h",
      uv_index: "",
      surface_pressure: "hPa",
      cloud_cover: "%",
    },
    utc_offset_seconds: offset,
    utc_offset_estimated: true,
  };
}

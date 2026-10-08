/**
 * Deterministic one-line insights for every metric card — the Apple Weather
 * pattern where each card carries one interpretive sentence computed from the
 * data ("Low for the rest of the day.", "+5° above the average daily high").
 *
 * Pure functions over WeatherData. No AI call, no network, never throws:
 * missing or short arrays fall back to the current block or a neutral default.
 *
 * Time handling: Open-Meteo times are local wall-clock ISO strings with no
 * offset ("2026-10-08T14:00"). They are compared as wall-clock keys, never
 * through Date parsing, so results do not depend on the runtime timezone.
 */

import type { WeatherData, HourlyWeather, DailyWeather } from "./weather";
import { windDirection, uvLevel } from "./weather";
import { cloudLabel } from "./weather-labels";
import { dewPointFromTempHumidity } from "./activity-feasibility";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Hours ahead the wind card looks for a gust pick-up. */
const WIND_LOOKAHEAD_HOURS = 6;
/** Minimum rise (km/h) over the current gust before it is called out. */
const GUST_PICKUP_DELTA_KMH = 10;
/** Minimum peak gust (km/h) before a pick-up is worth mentioning. */
const GUST_PICKUP_MIN_KMH = 25;
/** UV index at or above which sun protection is advised. */
const UV_PROTECT_THRESHOLD = 3;
/** Apparent-vs-actual gap (°C) before feels-like is explained. */
const FEELS_DELTA_C = 2;
/** Relative humidity (%) above which heat is blamed on humidity. */
const FEELS_HUMID_RH = 60;
/** Wind speed (km/h) above which cold is blamed on wind. */
const FEELS_WIND_KMH = 15;
/** Hours ahead the visibility card looks for a deterioration. */
const VIS_LOOKAHEAD_HOURS = 6;
/** Hours ahead the cloud card looks for a change. */
const CLOUD_LOOKAHEAD_HOURS = 6;
/** Cloud cover (%) at or below which the sky counts as clearing. */
const CLEAR_CLOUD_PCT = 30;
/** Cloud cover (%) at or above which the sky counts as cloudy. */
const CLOUDY_PCT = 70;
/** Hours of precipitation history and forecast for the rain card. */
const RAIN_WINDOW_HOURS = 24;
/** mm in an hour that counts as rain. */
const RAIN_MM_THRESHOLD = 0.2;
/** Precipitation probability (%) that counts as rain likely. */
const RAIN_PROB_THRESHOLD = 60;
/** Daily precipitation (mm) that makes a day "rainy" for the rain card. */
const RAIN_DAY_MM_THRESHOLD = 1;
/** Pressure change (hPa) over 3 h that counts as a trend. */
const PRESSURE_TREND_HPA = 1;
/** Hours ahead the pressure card compares against. */
const PRESSURE_SPAN_HOURS = 3;
/** Full-scale UV index used for the gauge position. */
const UV_SCALE_MAX = 11;
/** Dew point (°C) at which the air is described as muggy. */
const MUGGY_DEW_POINT_C = 20;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const HOUR_MS = 3_600_000;

/** Wall-clock key (ms as if UTC) for a local ISO string, or null if unparseable. */
function wallKey(iso: string | undefined): number | null {
  if (typeof iso !== "string") return null;
  const m = WALL_RE.exec(iso);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

/** Wall-clock key for a JS Date using its local components. */
function nowWallKey(now: Date): number {
  return Date.UTC(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
  );
}

/** "YYYY-MM-DD" for the local calendar day of `now`. */
function localDateString(now: Date): string {
  const y = String(now.getFullYear()).padStart(4, "0");
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${mo}-${d}`;
}

/** "HH:MM" from a local ISO string, or null. */
function hhmm(iso: string | undefined): string | null {
  if (typeof iso !== "string") return null;
  const m = WALL_RE.exec(iso);
  return m ? `${m[4]}:${m[5]}` : null;
}

/** "HH:MM" for a wall-clock key. */
function hhmmFromKey(key: number): string {
  const d = new Date(key);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** Finite number from an array slot, or null. */
function at(arr: readonly number[] | undefined, i: number): number | null {
  if (!arr || i < 0 || i >= arr.length) return null;
  const v = arr[i];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Finite number or null (for current-block fields). */
function finite(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Index of the hourly slot containing `now` (last slot whose start is at or
 * before now). Falls back to 0 when now precedes the data, -1 when there is
 * no hourly data at all.
 */
function currentIndex(hourly: HourlyWeather | undefined, now: Date): number {
  const times = hourly?.time ?? [];
  if (times.length === 0) return -1;
  const nk = nowWallKey(now);
  let idx = -1;
  for (let i = 0; i < times.length; i++) {
    const k = wallKey(times[i]);
    if (k === null) continue;
    if (k <= nk) idx = i;
    else break;
  }
  return idx === -1 ? 0 : idx;
}

/** Indexes of hourly slots on the local day of `now`. */
function todayIndexes(hourly: HourlyWeather | undefined, now: Date): number[] {
  const times = hourly?.time ?? [];
  const day = localDateString(now);
  const out: number[] = [];
  for (let i = 0; i < times.length; i++) {
    if (typeof times[i] === "string" && times[i].startsWith(day)) out.push(i);
  }
  return out;
}

/** Format minutes as "2 h 10 min", "45 min" or "3 h". */
function formatDuration(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(totalMinutes));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

/** Round to one decimal place, dropping float noise. */
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Minus sign used in signed deltas (typographic, per UN/CEFACT-style copy). */
const MINUS = "−";

// ---------------------------------------------------------------------------
// Wind
// ---------------------------------------------------------------------------

/** Beaufort lower bounds in km/h for scale 1–12. */
const BEAUFORT_LOWER_KMH = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
const BEAUFORT_LABELS = [
  "Calm",
  "Light air",
  "Light breeze",
  "Gentle breeze",
  "Moderate breeze",
  "Fresh breeze",
  "Strong breeze",
  "Near gale",
  "Gale",
  "Strong gale",
  "Storm",
  "Violent storm",
  "Hurricane force",
];

function beaufortLabel(kmh: number): string {
  let scale = 0;
  for (const lower of BEAUFORT_LOWER_KMH) {
    if (kmh >= lower) scale++;
    else break;
  }
  return BEAUFORT_LABELS[scale];
}

export interface WindInsight {
  /** Sustained wind speed, km/h (rounded). */
  speed: number;
  /** Current gust speed, km/h (rounded). */
  gust: number;
  /** Direction the wind blows from, degrees. */
  directionDeg: number;
  /** Compass label for the direction, e.g. "ENE". */
  directionLabel: string;
  /** Beaufort-scale description of the sustained speed. */
  beaufortLabel: string;
  sentence: string;
}

/**
 * Wind card insight. `now` locates the current hour for the gust pick-up
 * check; it defaults to the current time so `windInsight(w)` works.
 */
export function windInsight(
  w: WeatherData,
  now: Date = new Date(),
): WindInsight {
  const c = w?.current;
  const hourly = w?.hourly;
  const idx = currentIndex(hourly, now);

  const speedRaw =
    finite(c?.wind_speed_10m) ?? at(hourly?.wind_speed_10m, idx) ?? 0;
  const gustRaw =
    finite(c?.wind_gusts_10m) ?? at(hourly?.wind_gusts_10m, idx) ?? speedRaw;
  const dirDeg =
    finite(c?.wind_direction_10m) ?? at(hourly?.wind_direction_10m, idx) ?? 0;
  const speed = Math.round(speedRaw);
  const gust = Math.round(Math.max(gustRaw, speedRaw));
  const directionLabel = windDirection(dirDeg);

  // Peak gust over the next few hours (including now).
  let peak = -1;
  let peakIdx = -1;
  if (idx >= 0) {
    for (
      let i = idx;
      i <=
      Math.min(idx + WIND_LOOKAHEAD_HOURS, (hourly?.time?.length ?? 0) - 1);
      i++
    ) {
      const g = at(hourly?.wind_gusts_10m, i);
      if (g !== null && g > peak) {
        peak = g;
        peakIdx = i;
      }
    }
  }
  const peakRounded = Math.round(peak);

  let sentence: string;
  if (
    peakIdx > idx &&
    peakRounded >= GUST_PICKUP_MIN_KMH &&
    peakRounded - gust >= GUST_PICKUP_DELTA_KMH
  ) {
    const at_ = hhmm(hourly?.time?.[peakIdx]);
    sentence = at_
      ? `Gusts picking up to ${peakRounded} km/h by ${at_}.`
      : `Gusts picking up to ${peakRounded} km/h.`;
  } else if (Math.max(speed, gust) < 2) {
    sentence = "Calm conditions.";
  } else {
    sentence = `Gusts up to ${gust} km/h from the ${directionLabel}.`;
  }

  return {
    speed,
    gust,
    directionDeg: dirDeg,
    directionLabel,
    beaufortLabel: beaufortLabel(speed),
    sentence,
  };
}

// ---------------------------------------------------------------------------
// UV
// ---------------------------------------------------------------------------

export interface UvInsight {
  /** Current UV index. */
  value: number;
  /** WHO-style label from uvLevel(), e.g. "Low", "Very High". */
  label: string;
  /** Highest UV index forecast for the rest of the local day. */
  peakToday: number;
  /** HH:MM of the first hour at the day's peak, or null. */
  peakTime: string | null;
  /** HH:MM of the first hour with UV at or above 3 today, or null. */
  protectFrom: string | null;
  /** HH:MM at the end of the last hour with UV at or above 3 today, or null. */
  protectUntil: string | null;
  /** Position of the current value on a 0–11+ scale, 0–100. */
  positionPct: number;
  sentence: string;
}

/** Stable label for a UV value, shared by the sentence and the card. */
function uvLabel(v: number): string {
  return uvLevel(v).label;
}

export function uvInsight(w: WeatherData, now: Date): UvInsight {
  const c = w?.current;
  const hourly = w?.hourly;
  const idx = currentIndex(hourly, now);
  const value = Math.max(
    0,
    finite(c?.uv_index) ?? at(hourly?.uv_index, idx) ?? 0,
  );
  const positionPct = Math.round(
    Math.min(100, Math.max(0, (value / UV_SCALE_MAX) * 100)),
  );

  const today = todayIndexes(hourly, now);
  let peakToday = 0;
  let peakTime: string | null = null;
  let protectFrom: string | null = null;
  let protectUntil: string | null = null;
  let lastProtectIdx = -1;
  let remainingPeak = value;
  let hasHourlyUv = false;

  for (const i of today) {
    const uv = at(hourly?.uv_index, i);
    if (uv === null) continue;
    hasHourlyUv = true;
    if (uv > peakToday) {
      peakToday = uv;
      peakTime = hhmm(hourly?.time?.[i]);
    }
    if (uv >= UV_PROTECT_THRESHOLD) {
      if (protectFrom === null) protectFrom = hhmm(hourly?.time?.[i]);
      lastProtectIdx = i;
    }
    if (idx >= 0 && i >= idx && uv > remainingPeak) remainingPeak = uv;
  }

  if (lastProtectIdx >= 0) {
    const endKey = wallKey(hourly?.time?.[lastProtectIdx]);
    if (endKey !== null) protectUntil = hhmmFromKey(endKey + HOUR_MS);
  }

  const roundedPeak = round1(peakToday);
  let sentence: string;
  if (finite(c?.uv_index) === null && !hasHourlyUv) {
    sentence = "UV data unavailable.";
  } else if (remainingPeak < UV_PROTECT_THRESHOLD) {
    sentence = `${uvLabel(remainingPeak)} for the rest of the day.`;
  } else if (value >= UV_PROTECT_THRESHOLD && protectUntil) {
    sentence = `Use sun protection until ${protectUntil}.`;
  } else if (protectFrom && protectUntil) {
    sentence = `Use sun protection ${protectFrom}–${protectUntil}.`;
  } else {
    sentence = `Peaks at ${roundedPeak} around ${peakTime ?? "midday"}.`;
  }

  return {
    value: round1(value),
    label: uvLabel(value),
    peakToday: roundedPeak,
    peakTime,
    protectFrom,
    protectUntil,
    positionPct,
    sentence,
  };
}

// ---------------------------------------------------------------------------
// Feels like
// ---------------------------------------------------------------------------

export interface FeelsLikeInsight {
  /** Apparent temperature, °C (rounded). */
  value: number;
  /** Apparent minus actual, °C (rounded). Positive = feels warmer. */
  delta: number;
  sentence: string;
}

export function feelsLikeInsight(w: WeatherData): FeelsLikeInsight {
  const c = w?.current;
  const actual = finite(c?.temperature_2m);
  const apparent = finite(c?.apparent_temperature) ?? actual;
  const rh = finite(c?.relative_humidity_2m);
  const wind = finite(c?.wind_speed_10m);

  if (apparent === null || actual === null) {
    return {
      value: 0,
      delta: 0,
      sentence: "Feels-like temperature unavailable.",
    };
  }

  const rawDelta = apparent - actual;
  const delta = Math.round(rawDelta);
  const value = Math.round(apparent);

  let sentence: string;
  if (rawDelta >= FEELS_DELTA_C && rh !== null && rh >= FEELS_HUMID_RH) {
    sentence =
      "It feels warmer than the actual temperature, because of the humidity.";
  } else if (
    rawDelta <= -FEELS_DELTA_C &&
    wind !== null &&
    wind >= FEELS_WIND_KMH
  ) {
    sentence =
      "It feels cooler than the actual temperature, because of the wind.";
  } else if (rawDelta >= FEELS_DELTA_C) {
    sentence = "It feels warmer than the actual temperature.";
  } else if (rawDelta <= -FEELS_DELTA_C) {
    sentence = "It feels cooler than the actual temperature.";
  } else {
    sentence = "Similar to the actual temperature.";
  }

  return { value, delta, sentence };
}

// ---------------------------------------------------------------------------
// Precipitation
// ---------------------------------------------------------------------------

export interface PrecipitationInsight {
  /** Precipitation over the 24 hours up to and including now, mm. */
  last24hMm: number;
  /** Precipitation forecast over the next 24 hours from now, mm. */
  next24hMm: number;
  /** HH:MM when rain is next expected within 24 h, or null. */
  nextRainTime: string | null;
  /**
   * Day label when a later day carries rain (or "today"/"tomorrow"), or null.
   * Used for the daily fallback sentence.
   */
  nextRainDay: string | null;
  sentence: string;
}

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function isRainyHour(hourly: HourlyWeather, i: number): boolean {
  const mm = at(hourly.precipitation, i);
  const prob = at(hourly.precipitation_probability, i);
  return (
    (mm !== null && mm >= RAIN_MM_THRESHOLD) ||
    (prob !== null && prob >= RAIN_PROB_THRESHOLD)
  );
}

/** Label for a daily index: "today", "tomorrow" or a weekday name. */
function dayLabel(daily: DailyWeather, i: number, now: Date): string | null {
  const iso = daily.time?.[i];
  if (typeof iso !== "string") return null;
  const m = DATE_RE.exec(iso);
  if (!m) return null;
  const target = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.round((target - today) / 86_400_000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "tomorrow";
  return WEEKDAYS[new Date(target).getUTCDay()];
}

export function precipitationInsight(
  w: WeatherData,
  now: Date,
): PrecipitationInsight {
  const hourly = w?.hourly ?? ({} as HourlyWeather);
  const daily = w?.daily ?? ({} as DailyWeather);
  const idx = currentIndex(hourly, now);
  const n = hourly.time?.length ?? 0;

  let last24hMm = 0;
  let next24hMm = 0;
  if (idx >= 0) {
    for (let i = Math.max(0, idx - RAIN_WINDOW_HOURS + 1); i <= idx; i++) {
      last24hMm += at(hourly.precipitation, i) ?? 0;
    }
    for (let i = idx; i < Math.min(n, idx + RAIN_WINDOW_HOURS); i++) {
      next24hMm += at(hourly.precipitation, i) ?? 0;
    }
  }

  let nextRainTime: string | null = null;
  let rainingNow = false;
  if (idx >= 0) {
    rainingNow = isRainyHour(hourly, idx);
    if (!rainingNow) {
      for (let i = idx + 1; i < Math.min(n, idx + RAIN_WINDOW_HOURS); i++) {
        if (isRainyHour(hourly, i)) {
          nextRainTime = hhmm(hourly.time?.[i]);
          break;
        }
      }
    }
  }

  // Daily fallback: first day from today on with meaningful rain.
  let nextRainDay: string | null = null;
  let nextRainDayMm = 0;
  const dailyTimes = daily.time ?? [];
  for (let i = 0; i < dailyTimes.length; i++) {
    const mm = at(daily.precipitation_sum, i);
    if (mm === null || mm < RAIN_DAY_MM_THRESHOLD) continue;
    const label = dayLabel(daily, i, now);
    // Today's daily total may already have fallen, so only later days count.
    if (label === null || label === "today") continue;
    nextRainDay = label;
    nextRainDayMm = mm;
    break;
  }

  const lastPart = `${round1(last24hMm)} mm in the last 24 h.`;
  let nextPart: string;
  if (rainingNow) {
    nextPart = "Raining now.";
  } else if (nextRainTime) {
    nextPart = `Rain likely from ${nextRainTime}.`;
  } else if (nextRainDay) {
    nextPart = `${round1(nextRainDayMm)} mm expected ${nextRainDay}.`;
  } else {
    nextPart = "No rain expected in the next week.";
  }

  return {
    last24hMm: round1(last24hMm),
    next24hMm: round1(next24hMm),
    nextRainTime,
    nextRainDay,
    sentence: `${lastPart} ${nextPart}`,
  };
}

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

export type VisibilityLabel =
  | "Perfectly clear"
  | "Clear"
  | "Haze"
  | "Poor"
  | "Fog";

const VIS_RANK: Record<VisibilityLabel, number> = {
  Fog: 0,
  Poor: 1,
  Haze: 2,
  Clear: 3,
  "Perfectly clear": 4,
};

export interface VisibilityInsight {
  /** Visibility in km, rounded to one decimal; null when unknown. */
  km: number | null;
  label: VisibilityLabel | "Unknown";
  sentence: string;
}

function visibilityLabel(km: number): VisibilityLabel {
  if (km >= 20) return "Perfectly clear";
  if (km >= 10) return "Clear";
  if (km >= 4) return "Haze";
  if (km >= 1) return "Poor";
  return "Fog";
}

export function visibilityInsight(
  w: WeatherData,
  now: Date,
): VisibilityInsight {
  const hourly = w?.hourly;
  const idx = currentIndex(hourly, now);
  const metres = at(hourly?.visibility, idx);
  if (metres === null) {
    return {
      km: null,
      label: "Unknown",
      sentence: "Visibility data unavailable.",
    };
  }

  const km = round1(metres / 1000);
  const label = visibilityLabel(metres / 1000);

  // Worst visibility in the look-ahead window.
  let worstKm = metres / 1000;
  let worstIdx = -1;
  const last = Math.min(
    idx + VIS_LOOKAHEAD_HOURS,
    (hourly?.time?.length ?? 0) - 1,
  );
  for (let i = idx + 1; i <= last; i++) {
    const v = at(hourly?.visibility, i);
    if (v !== null && v / 1000 < worstKm) {
      worstKm = v / 1000;
      worstIdx = i;
    }
  }

  let sentence: string;
  if (label === "Fog") {
    sentence = `Fog, visibility ${km} km.`;
  } else if (label === "Haze") {
    sentence = `Haze, visibility ${km} km.`;
  } else if (label === "Poor") {
    sentence = `Poor visibility, ${km} km.`;
  } else {
    sentence = `${label}, visibility ${km} km.`;
  }

  if (worstIdx > idx) {
    const worstLabel = visibilityLabel(worstKm);
    if (VIS_RANK[worstLabel] < VIS_RANK[label]) {
      const at_ = hhmm(hourly?.time?.[worstIdx]);
      const when = at_ ? ` by ${at_}` : "";
      if (worstLabel === "Fog") sentence += ` Fog expected${when}.`;
      else if (worstLabel === "Haze") sentence += ` Haze expected${when}.`;
      else sentence += ` Visibility drops to ${round1(worstKm)} km${when}.`;
    }
  }

  return { km, label, sentence };
}

// ---------------------------------------------------------------------------
// Humidity / dew point
// ---------------------------------------------------------------------------

export interface HumidityInsight {
  /** Relative humidity, %. */
  value: number;
  /** Dew point, °C (rounded). */
  dewPoint: number;
  sentence: string;
}

function comfortFromDewPoint(dp: number): string {
  if (dp >= MUGGY_DEW_POINT_C) return "Muggy.";
  if (dp >= 16) return "Humid.";
  if (dp >= 10) return "Comfortable.";
  return "Dry.";
}

export function humidityInsight(w: WeatherData): HumidityInsight {
  const c = w?.current;
  const temp = finite(c?.temperature_2m);
  const rh = finite(c?.relative_humidity_2m);
  if (temp === null || rh === null) {
    return { value: 0, dewPoint: 0, sentence: "Humidity data unavailable." };
  }
  const clampedRh = Math.min(100, Math.max(0, rh));
  const dewPoint = Math.round(dewPointFromTempHumidity(temp, clampedRh));
  return {
    value: Math.round(clampedRh),
    dewPoint,
    sentence: `The dew point is ${dewPoint}° right now. ${comfortFromDewPoint(dewPoint)}`,
  };
}

// ---------------------------------------------------------------------------
// Pressure
// ---------------------------------------------------------------------------

export interface PressureInsight {
  /** Surface pressure, hPa (rounded). */
  hPa: number;
  trend: "rising" | "falling" | "steady";
  sentence: string;
}

export function pressureInsight(w: WeatherData, now: Date): PressureInsight {
  const hourly = w?.hourly;
  const idx = currentIndex(hourly, now);
  const current =
    finite(w?.current?.surface_pressure) ?? at(hourly?.surface_pressure, idx);
  if (current === null) {
    return { hPa: 0, trend: "steady", sentence: "Pressure data unavailable." };
  }

  const past = at(hourly?.surface_pressure, idx - PRESSURE_SPAN_HOURS);
  const ahead = at(hourly?.surface_pressure, idx + PRESSURE_SPAN_HOURS);
  const deltas: number[] = [];
  if (past !== null) deltas.push(current - past);
  if (ahead !== null) deltas.push(ahead - current);
  const avg = deltas.length
    ? deltas.reduce((a, b) => a + b, 0) / deltas.length
    : 0;

  let trend: PressureInsight["trend"] = "steady";
  if (avg >= PRESSURE_TREND_HPA) trend = "rising";
  else if (avg <= -PRESSURE_TREND_HPA) trend = "falling";

  const sentence =
    trend === "rising"
      ? "Rising — settled weather is likely."
      : trend === "falling"
        ? "Falling — unsettled weather may be on the way."
        : "Steady — no big change expected.";

  return { hPa: Math.round(current), trend, sentence };
}

// ---------------------------------------------------------------------------
// Sun
// ---------------------------------------------------------------------------

export interface SunInsight {
  /** Sunrise HH:MM for the local day, or null. */
  sunrise: string | null;
  /** Sunset HH:MM for the local day, or null. */
  sunset: string | null;
  /** Hours of daylight today, one decimal. */
  daylightHours: number;
  isDaytime: boolean;
  /** Position of now between sunrise and sunset, 0–100; null at night. */
  arcPct: number | null;
  nextEventLabel: "Sunrise" | "Sunset";
  /** HH:MM of the next sunrise or sunset, or null. */
  nextEventTime: string | null;
  sentence: string;
}

function minutesOfDay(iso: string | undefined): number | null {
  const k = wallKey(iso);
  if (k === null) return null;
  const d = new Date(k);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function sunInsight(w: WeatherData, now: Date): SunInsight {
  const daily = w?.daily ?? ({} as DailyWeather);
  const today = localDateString(now);
  const dayIdx = (daily.time ?? []).findIndex(
    (t) => typeof t === "string" && t.startsWith(today),
  );
  const nowMin = now.getHours() * 60 + now.getMinutes();

  const riseIso = dayIdx >= 0 ? daily.sunrise?.[dayIdx] : undefined;
  const setIso = dayIdx >= 0 ? daily.sunset?.[dayIdx] : undefined;
  const rise = minutesOfDay(riseIso);
  const set = minutesOfDay(setIso);

  if (rise === null || set === null || set <= rise) {
    return {
      sunrise: hhmm(riseIso),
      sunset: hhmm(setIso),
      daylightHours: 0,
      isDaytime: finite(w?.current?.is_day) === 1,
      arcPct: null,
      nextEventLabel: "Sunrise",
      nextEventTime: null,
      sentence: "Sunrise and sunset times unavailable.",
    };
  }

  const daylightMin = set - rise;
  const daylightHours = round1(daylightMin / 60);
  const isDaytime = nowMin >= rise && nowMin < set;
  const arcPct = isDaytime
    ? Math.round(
        Math.min(100, Math.max(0, ((nowMin - rise) / daylightMin) * 100)),
      )
    : null;

  let nextEventLabel: "Sunrise" | "Sunset";
  let nextEventTime: string;
  let untilMin: number;
  if (isDaytime) {
    nextEventLabel = "Sunset";
    nextEventTime = hhmm(setIso) ?? "";
    untilMin = set - nowMin;
  } else {
    nextEventLabel = "Sunrise";
    if (nowMin < rise) {
      nextEventTime = hhmm(riseIso) ?? "";
      untilMin = rise - nowMin;
    } else {
      // After sunset: the next sunrise is tomorrow's, falling back to today's
      // sunrise time shifted by a day when tomorrow's is missing.
      const tomorrowIso = daily.sunrise?.[dayIdx + 1];
      const tomorrowRise = minutesOfDay(tomorrowIso);
      nextEventTime = hhmm(tomorrowIso) ?? hhmm(riseIso) ?? "";
      untilMin = 24 * 60 - nowMin + (tomorrowRise ?? rise);
    }
  }

  const sentence = `${nextEventLabel} in ${formatDuration(untilMin)}.`;

  return {
    sunrise: hhmm(riseIso),
    sunset: hhmm(setIso),
    daylightHours,
    isDaytime,
    arcPct,
    nextEventLabel,
    nextEventTime: nextEventTime || null,
    sentence,
  };
}

// ---------------------------------------------------------------------------
// Cloud
// ---------------------------------------------------------------------------

export interface CloudInsight {
  /** Cloud cover, %. */
  value: number;
  label: string;
  sentence: string;
}

export function cloudInsight(w: WeatherData, now: Date): CloudInsight {
  const hourly = w?.hourly;
  const idx = currentIndex(hourly, now);
  const value = Math.round(
    Math.min(
      100,
      Math.max(
        0,
        finite(w?.current?.cloud_cover) ?? at(hourly?.cloud_cover, idx) ?? 0,
      ),
    ),
  );
  const label = cloudLabel(value);

  const last = Math.min(
    idx + CLOUD_LOOKAHEAD_HOURS,
    (hourly?.time?.length ?? 0) - 1,
  );
  let sentence = `${label}.`;

  if (idx >= 0 && value >= CLOUDY_PCT) {
    for (let i = idx + 1; i <= last; i++) {
      const c = at(hourly?.cloud_cover, i);
      if (c !== null && c <= CLEAR_CLOUD_PCT) {
        const prev = hhmm(hourly?.time?.[i - 1]);
        if (prev) sentence = `Clearing after ${prev}.`;
        break;
      }
    }
  } else if (idx >= 0 && value <= CLEAR_CLOUD_PCT) {
    for (let i = idx + 1; i <= last; i++) {
      const c = at(hourly?.cloud_cover, i);
      if (c !== null && c >= CLOUDY_PCT) {
        const prev = hhmm(hourly?.time?.[i - 1]);
        if (prev) sentence = `Clouding over after ${prev}.`;
        break;
      }
    }
  }

  return { value, label, sentence };
}

// ---------------------------------------------------------------------------
// Temperature against normal
// ---------------------------------------------------------------------------

export interface TemperatureAverageInsight {
  /** Today's high minus the normal high, rounded to whole degrees. */
  delta: number;
  sentence: string;
}

/**
 * Compare today's high to the climatological average high. Returns null when
 * the normal is unknown, so callers can omit the line entirely.
 */
export function temperatureAverageInsight(
  todayHigh: number | null | undefined,
  normalHigh: number | null | undefined,
): TemperatureAverageInsight | null {
  if (
    typeof todayHigh !== "number" ||
    typeof normalHigh !== "number" ||
    !Number.isFinite(todayHigh) ||
    !Number.isFinite(normalHigh)
  ) {
    return null;
  }
  const raw = todayHigh - normalHigh;
  if (Math.abs(raw) < 1) {
    return { delta: 0, sentence: "Near the average daily high." };
  }
  const delta = Math.round(raw);
  const sentence =
    delta > 0
      ? `+${delta}° above the average daily high`
      : `${MINUS}${Math.abs(delta)}° below the average daily high`;
  return { delta, sentence };
}

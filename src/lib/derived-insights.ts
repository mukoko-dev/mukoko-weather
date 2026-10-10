/**
 * Weather insights derived from global-model data — no Tomorrow.io needed.
 *
 * TypeScript mirror of `api/py/_insights.py` (issue #246). The server derives
 * insights for every `/api/py/weather` response; this copy covers the TS
 * direct-Open-Meteo fallback path (`synthesizeOpenMeteoInsights`). The
 * formulas are pinned by tests on both sides — change one, change both.
 *
 * Kept free of imports from `./weather` so `weather.ts` can depend on it
 * without a cycle.
 */

/** Dew point (°C) from air temperature and relative humidity (Magnus). */
export function dewPointC(
  tempC: number | null | undefined,
  rhPercent: number | null | undefined,
): number | undefined {
  if (tempC == null || rhPercent == null) return undefined;
  const rh = Math.min(100, Math.max(1, rhPercent));
  const a = 17.625;
  const b = 243.04;
  const gamma = Math.log(rh / 100) + (a * tempC) / (b + tempC);
  return Math.round(((b * gamma) / (a - gamma)) * 10) / 10;
}

/**
 * NOAA heat index (Rothfusz regression) in °C. Below 27 °C it is the air
 * temperature — the heat-stress approximation behind `heatStressIndex`.
 */
export function heatIndexC(
  tempC: number | null | undefined,
  rhPercent: number | null | undefined,
): number | undefined {
  if (tempC == null || rhPercent == null) return undefined;
  if (tempC < 27) return Math.round(tempC * 10) / 10;
  const rh = Math.min(100, Math.max(0, rhPercent));
  const t = (tempC * 9) / 5 + 32;
  let hi =
    -42.379 +
    2.04901523 * t +
    10.14333127 * rh -
    0.22475541 * t * rh -
    6.83783e-3 * t * t -
    5.481717e-2 * rh * rh +
    1.22874e-3 * t * t * rh +
    8.5282e-4 * t * rh * rh -
    1.99e-6 * t * t * rh * rh;
  if (rh < 13 && t >= 80 && t <= 112) {
    hi -= ((13 - rh) / 4) * Math.sqrt((17 - Math.abs(t - 95)) / 17);
  } else if (rh > 85 && t >= 80 && t <= 87) {
    hi += ((rh - 85) / 10) * ((87 - t) / 5);
  }
  return Math.round((((hi - 32) * 5) / 9) * 10) / 10;
}

/** Daily growing degree days with base + upper-cap clamping. */
export function growingDegreeDays(
  tmax: number | null | undefined,
  tmin: number | null | undefined,
  base: number,
  cap: number,
): number | undefined {
  if (tmax == null || tmin == null) return undefined;
  const hi = Math.min(Math.max(tmax, base), cap);
  const lo = Math.min(Math.max(tmin, base), cap);
  return Math.round(Math.max(0, (hi + lo) / 2 - base) * 10) / 10;
}

/** The four GDD fields the suitability rules can read: [key, base, cap]. */
export const GDD_DEFINITIONS = [
  ["gdd10To30", 10, 30],
  ["gdd10To31", 10, 31],
  ["gdd08To30", 8, 30],
  ["gdd03To25", 3, 25],
] as const;

/**
 * Thunderstorm potential (%) from CAPE (J/kg) and lifted index (K) — a
 * documented proxy, not a calibrated probability. Either signal alone counts.
 */
export function convectiveProxy(
  cape: number | null | undefined,
  liftedIndex: number | null | undefined,
): number {
  const c = typeof cape === "number" ? cape : null;
  const li = typeof liftedIndex === "number" ? liftedIndex : null;
  if ((c !== null && c >= 2500) || (li !== null && li <= -6)) return 60;
  if ((c !== null && c >= 1000) || (li !== null && li <= -3)) return 40;
  if ((c !== null && c >= 500) || (li !== null && li <= -1)) return 20;
  return 0;
}

const NEW_MOON_REF_MS = Date.UTC(2000, 0, 6, 18, 14);
const SYNODIC_DAYS = 29.530588853;

/** Moon phase on Tomorrow.io's 0–7 scale (0 new … 4 full … 7 waning crescent). */
export function moonPhase(when: Date = new Date()): number {
  const days = (when.getTime() - NEW_MOON_REF_MS) / 86_400_000;
  const age = ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS;
  return Math.round((age / SYNODIC_DAYS) * 8) % 8;
}

/** Convective cloud base (km) ≈ LCL = 125 m × (T − Td); none under 10 % cover. */
export function cloudBaseKm(
  tempC: number | null | undefined,
  dewC: number | null | undefined,
  cloudCover: number | null | undefined,
): number | undefined {
  if (tempC == null || dewC == null || cloudCover == null) return undefined;
  if (cloudCover < 10) return undefined;
  return Math.round(Math.max(0, tempC - dewC) * 0.125 * 100) / 100;
}

/** Hours ahead scanned for convective potential (mirrors CONVECTIVE_WINDOW_H). */
export const CONVECTIVE_WINDOW_H = 6;

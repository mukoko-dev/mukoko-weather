/**
 * The air-quality detail: the pollutant list, the health guidance and how fresh
 * the reading is. Pure functions over the Worker's `/v1/air-quality` answer.
 *
 * Honesty rules (owner brief): the index is a US EPA AQI (0-500) and is never
 * mixed with another scale; a missing pollutant is "no data", never zero; the
 * WHO guideline is a 24-hour value and the reading is current, so the
 * comparison says so; the guidance is general, not medical advice.
 */

import { AQI_ADVICE } from "./display";
import { aqiBand, AQI_BAND_LABELS, type AqiBand } from "./aq-grid";

export type PollutantKey =
  | "pm2_5"
  | "pm10"
  | "o3"
  | "no2"
  | "so2"
  | "co"
  | "nh3";

export type AqiLevel = keyof typeof AQI_ADVICE;

/** The slice of the Worker's answer the detail reads. */
export interface AirQualityReading {
  aqi: number;
  level?: string;
  dominantPollutant: PollutantKey | null;
  pollutants: Partial<Record<PollutantKey, number | null>>;
  subIndexes?: Partial<Record<PollutantKey, number>>;
  whoGuidelines?: Partial<Record<PollutantKey, number>>;
  source?: string;
  fetchedAt?: string;
}

/** Display order when two pollutants tie: the ones people ask about first. */
export const POLLUTANT_ORDER: readonly PollutantKey[] = [
  "pm2_5",
  "pm10",
  "o3",
  "no2",
  "so2",
  "co",
  "nh3",
];

export const POLLUTANT_NAMES: Record<PollutantKey, string> = {
  pm2_5: "Fine particles",
  pm10: "Coarse particles",
  o3: "Ozone",
  no2: "Nitrogen dioxide",
  so2: "Sulphur dioxide",
  co: "Carbon monoxide",
  nh3: "Ammonia",
};

export const POLLUTANT_SYMBOLS: Record<PollutantKey, string> = {
  pm2_5: "PM2.5",
  pm10: "PM10",
  o3: "O₃",
  no2: "NO₂",
  so2: "SO₂",
  co: "CO",
  nh3: "NH₃",
};

/** The six EPA bands with their index range, for a legend that is not colour only. */
export const AQI_RANGES: readonly { band: AqiBand; range: string }[] = [
  { band: "good", range: "0–50" },
  { band: "moderate", range: "51–100" },
  { band: "usg", range: "101–150" },
  { band: "unhealthy", range: "151–200" },
  { band: "very_unhealthy", range: "201–300" },
  { band: "hazardous", range: "301+" },
];

const BAND_LEVEL: Record<AqiBand, AqiLevel> = {
  good: "good",
  moderate: "moderate",
  usg: "unhealthy_sensitive",
  unhealthy: "unhealthy",
  very_unhealthy: "very_unhealthy",
  hazardous: "hazardous",
};

export const GUIDANCE_DISCLAIMER =
  "General guidance for the US EPA index, not medical advice. If you have a heart or lung condition, follow your doctor's advice.";

export interface AirQualityGuidance {
  bandLabel: string;
  text: string;
  disclaimer: string;
}

/** The band label and the plain-language guidance for an index value. */
export function guidanceFor(reading: AirQualityReading): AirQualityGuidance {
  const band = aqiBand(reading.aqi);
  const level =
    reading.level && reading.level in AQI_ADVICE
      ? (reading.level as AqiLevel)
      : BAND_LEVEL[band];
  return {
    bandLabel: AQI_BAND_LABELS[band],
    text: AQI_ADVICE[level],
    disclaimer: GUIDANCE_DISCLAIMER,
  };
}

const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/** A concentration in µg/m³, or null when there is no reading. */
export function formatConcentration(
  value: number | null | undefined,
): string | null {
  if (!finite(value)) return null;
  return value >= 100
    ? `${Math.round(value)} µg/m³`
    : `${value.toFixed(1)} µg/m³`;
}

/** How the current reading sits against a WHO guideline, or null when there is none. */
export function whoNote(
  value: number | null | undefined,
  guideline: number | null | undefined,
): string | null {
  if (!finite(value) || !finite(guideline) || guideline <= 0) return null;
  const ratio = value / guideline;
  if (ratio <= 1) return "Within the WHO guideline";
  return `${ratio.toFixed(1)}× the WHO guideline`;
}

export interface PollutantRow {
  key: PollutantKey;
  symbol: string;
  name: string;
  /** "12.3 µg/m³", or null when there is no reading (shown as "No data"). */
  valueText: string | null;
  /** EPA sub-index for this pollutant, when it has one. */
  subIndex: number | null;
  who: string | null;
  isMain: boolean;
}

/**
 * Every pollutant, the main one first, then by EPA sub-index, then in the
 * fixed order. A pollutant with no reading is kept (as "no data") so a gap is
 * visible rather than hidden.
 */
export function pollutantRows(reading: AirQualityReading): PollutantRow[] {
  const rows = POLLUTANT_ORDER.map((key): PollutantRow => {
    const value = reading.pollutants?.[key];
    const sub = reading.subIndexes?.[key];
    return {
      key,
      symbol: POLLUTANT_SYMBOLS[key],
      name: POLLUTANT_NAMES[key],
      valueText: formatConcentration(value),
      subIndex: finite(sub) ? Math.round(sub) : null,
      who: whoNote(value, reading.whoGuidelines?.[key]),
      isMain: reading.dominantPollutant === key,
    };
  });
  const order = (r: PollutantRow) => POLLUTANT_ORDER.indexOf(r.key);
  return rows.sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    const as = a.subIndex ?? -1;
    const bs = b.subIndex ?? -1;
    if (as !== bs) return bs - as;
    return order(a) - order(b);
  });
}

/** "Updated 12 min ago", or null when the time is missing or unreadable. */
export function freshnessLabel(
  fetchedAt: string | undefined,
  nowMs: number,
): string | null {
  if (!fetchedAt) return null;
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.round((nowMs - t) / 60_000));
  if (min < 1) return "Updated just now";
  if (min < 60) return `Updated ${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `Updated ${h} h ago` : "Updated more than a day ago";
}

/**
 * Position on the AQI scale bar, 0–100. Each EPA band occupies an equal
 * sixth of the bar so the colour ramp and the band edges line up by eye.
 */
export function aqiScalePct(aqi: number): number {
  const v = Math.max(0, Math.min(500, aqi));
  const edges = [0, 50, 100, 150, 200, 300, 500];
  for (let i = 1; i < edges.length; i++) {
    if (v <= edges[i]) {
      const lo = edges[i - 1];
      const hi = edges[i];
      const within = (v - lo) / (hi - lo);
      return ((i - 1 + within) / (edges.length - 1)) * 100;
    }
  }
  return 100;
}

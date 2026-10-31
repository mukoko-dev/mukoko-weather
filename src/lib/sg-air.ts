/**
 * Official Singapore air quality (NEA via data.gov.sg) — client-side types,
 * PSI band mapping and the response guard for `/v1/sg-air`.
 *
 * Pure logic, no React, so every rule here is unit-tested directly. The band
 * thresholds mirror `PSI_BANDS` in `weather_core::sg_air`; keep them in sync.
 */

import { PSI_SCALE } from "@/lib/weather-scales";

export type PsiBandKey =
  | "good"
  | "moderate"
  | "unhealthy"
  | "very_unhealthy"
  | "hazardous";

export type SgRegion = "north" | "south" | "east" | "west" | "central";

/** `"national"` when NEA reports one; `"highest_region"` when derived. */
export type SgBasis = "national" | "highest_region";

export interface SgRegionReading {
  region: SgRegion;
  psi24h: number | null;
  band: PsiBandKey | null;
  pm25OneHour: number | null;
  labelLatitude: number | null;
  labelLongitude: number | null;
}

export interface SgAirResponse {
  available: boolean;
  source: string;
  observedAt: string | null;
  fetchedAt: string | null;
  psi24h: number | null;
  psiBasis: SgBasis | null;
  band: PsiBandKey | null;
  bandLabel: string | null;
  pm25OneHour: number | null;
  pm25Basis: SgBasis | null;
  regions: SgRegionReading[];
  nearestRegion: string | null;
}

/** Upper bounds are inclusive; anything above the last is hazardous. */
const PSI_UPPER_BOUNDS: ReadonlyArray<{ max: number; key: PsiBandKey }> = [
  { max: 50, key: "good" },
  { max: 100, key: "moderate" },
  { max: 200, key: "unhealthy" },
  { max: 300, key: "very_unhealthy" },
];

export const PSI_BAND_LABELS: Record<PsiBandKey, string> = {
  good: "Good",
  moderate: "Moderate",
  unhealthy: "Unhealthy",
  very_unhealthy: "Very unhealthy",
  hazardous: "Hazardous",
};

/**
 * Fill class per PSI band, from PSI_SCALE (weather-scales.ts: NEA's band names
 * and ranges, EPA colours where the ranges match, flagged as ours). A swatch,
 * not text colour: the yellow band cannot be read as text on a card.
 */
export const PSI_BAND_BG_CLASS: Record<PsiBandKey, string> = {
  good: PSI_SCALE.bands[0].bg,
  moderate: PSI_SCALE.bands[1].bg,
  unhealthy: PSI_SCALE.bands[2].bg,
  very_unhealthy: PSI_SCALE.bands[3].bg,
  hazardous: PSI_SCALE.bands[4].bg,
};

export const SG_REGION_LABELS: Record<SgRegion, string> = {
  north: "North",
  south: "South",
  east: "East",
  west: "West",
  central: "Central",
};

/** PSI band for a 24-hour PSI value. Throws on a non-finite input. */
export function psiBandKey(value: number): PsiBandKey {
  if (!Number.isFinite(value)) throw new RangeError("PSI must be finite");
  for (const { max, key } of PSI_UPPER_BOUNDS) {
    if (value <= max) return key;
  }
  return "hazardous";
}

/**
 * Label and Tailwind fill class for a PSI value. The helper the panel
 * renders from, so the colour and wording can't drift apart.
 */
export function psiBandInfo(value: number): {
  key: PsiBandKey;
  label: string;
  bgClass: string;
} {
  const key = psiBandKey(value);
  return {
    key,
    label: PSI_BAND_LABELS[key],
    bgClass: PSI_BAND_BG_CLASS[key],
  };
}

/** Friendly region name ("west" → "West"); unknown ids pass through. */
export function sgRegionLabel(region: string): string {
  return SG_REGION_LABELS[region as SgRegion] ?? region;
}

/**
 * Shape guard for `/v1/sg-air`. An unavailable response is still valid
 * (it is how the endpoint reports a failed NEA read), so it is accepted and the
 * panel decides what to show.
 */
export function isSgAir(json: unknown): json is SgAirResponse {
  if (!json || typeof json !== "object") return false;
  const a = json as Partial<SgAirResponse>;
  if (typeof a.available !== "boolean") return false;
  if (!a.available) return true;
  return (
    typeof a.psi24h === "number" &&
    Number.isFinite(a.psi24h) &&
    Array.isArray(a.regions)
  );
}

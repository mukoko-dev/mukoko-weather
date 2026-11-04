/**
 * Air quality grid helpers for the Air Quality Map card.
 *
 * `/v1/air-quality/grid` (the Rust Worker) returns current US AQI on a regular n×n grid. This
 * module turns those points into one smooth, banded raster for a MapLibre
 * image source (field-raster.ts interpolates between the samples), classifies
 * AQI into EPA bands, and fetches the grid. Everything except
 * `fetchAirQualityGrid` is pure and unit-tested.
 */

import { workerData } from "@/lib/worker-data";
import { AQI_SCALE } from "@/lib/weather-scales";
import {
  buildFieldRaster,
  hasReadings,
  sampleGridFrom,
  type FieldRaster,
} from "@/lib/field-raster";

/** EPA US AQI categories, lowest to highest severity. */
export type AqiBand =
  | "good"
  | "moderate"
  | "usg"
  | "unhealthy"
  | "very_unhealthy"
  | "hazardous";

export const AQI_BANDS: readonly AqiBand[] = [
  "good",
  "moderate",
  "usg",
  "unhealthy",
  "very_unhealthy",
  "hazardous",
];

export const AQI_BAND_LABELS: Record<AqiBand, string> = {
  good: "Good",
  moderate: "Moderate",
  usg: "Unhealthy for sensitive groups",
  unhealthy: "Unhealthy",
  very_unhealthy: "Very unhealthy",
  hazardous: "Hazardous",
};

/**
 * The scale band behind each AqiBand: the six official US EPA AQI categories
 * (weather-scales.ts), so the map fill, bubbles, gauge and legend share one
 * source and cannot drift.
 */
const BAND_INDEX: Record<AqiBand, number> = {
  good: 0,
  moderate: 1,
  usg: 2,
  unhealthy: 3,
  very_unhealthy: 4,
  hazardous: 5,
};

function scaleBandOf(band: AqiBand) {
  return AQI_SCALE.bands[BAND_INDEX[band]];
}

/**
 * CSS custom property per band. The map paints with these resolved to concrete
 * colours (MapLibre paint values cannot read var()).
 */
export const AQI_BAND_TOKEN: Record<AqiBand, string> = Object.fromEntries(
  AQI_BANDS.map((b) => [b, scaleBandOf(b).token]),
) as Record<AqiBand, string>;

/** Static Tailwind fill classes for a band (bubbles, swatches). */
export const AQI_BAND_BG_CLASS: Record<AqiBand, string> = Object.fromEntries(
  AQI_BANDS.map((b) => [b, scaleBandOf(b).bg]),
) as Record<AqiBand, string>;

/**
 * Static Tailwind SVG fill classes for a band (the static air quality map's
 * cells), from the scale band's own `fill`.
 */
export const AQI_BAND_FILL_CLASS: Record<AqiBand, string> = Object.fromEntries(
  AQI_BANDS.map((b) => [b, scaleBandOf(b).fill ?? ""]),
) as Record<AqiBand, string>;

/** Foreground class that passes 4.5:1 on the band's fill (bubble numbers). */
export const AQI_BAND_FG_CLASS: Record<AqiBand, string> = Object.fromEntries(
  AQI_BANDS.map((b) => [b, scaleBandOf(b).on]),
) as Record<AqiBand, string>;

/** One AQI bubble on the full-screen map. `isCenter` marks the "my location" bubble. */
export interface AqBubble {
  lat: number;
  lon: number;
  aqi: number;
  band: AqiBand;
  isCenter: boolean;
}

/**
 * Bubbles for a grid response: one per grid point with a reading, plus the
 * centre reading as a larger "my location" bubble. The centre is also a grid
 * point, so that point is dropped to avoid drawing two bubbles on one spot.
 * Returns [] when the grid is unavailable.
 */
export function aqBubbles(grid: AqGridResponse): AqBubble[] {
  if (!grid.available) return [];
  const center = grid.center && grid.center.aqi !== null ? grid.center : null;
  const bubbles: AqBubble[] = [];
  for (const p of grid.points) {
    if (p.aqi === null) continue;
    if (
      center &&
      Math.abs(p.lat - center.lat) < 1e-6 &&
      Math.abs(p.lon - center.lon) < 1e-6
    ) {
      continue;
    }
    bubbles.push({
      lat: p.lat,
      lon: p.lon,
      aqi: Math.round(p.aqi),
      band: aqiBand(p.aqi),
      isCenter: false,
    });
  }
  if (center && center.aqi !== null) {
    bubbles.push({
      lat: center.lat,
      lon: center.lon,
      aqi: Math.round(center.aqi),
      band: aqiBand(center.aqi),
      isCenter: true,
    });
  }
  return bubbles;
}

/** EPA breakpoints: an integer AQI maps to the first band whose ceiling it does not exceed. */
const BAND_CEILINGS: ReadonlyArray<[number, AqiBand]> = [
  [50, "good"],
  [100, "moderate"],
  [150, "usg"],
  [200, "unhealthy"],
  [300, "very_unhealthy"],
];

/** Classify a US AQI value into its EPA band. Values are rounded to the nearest integer first. */
export function aqiBand(aqi: number): AqiBand {
  const value = Math.round(aqi);
  for (const [ceiling, band] of BAND_CEILINGS) {
    if (value <= ceiling) return band;
  }
  return "hazardous";
}

export interface AqGridPoint {
  lat: number;
  lon: number;
  aqi: number | null;
  pm2_5: number | null;
}

export interface AqGridResponse {
  available: boolean;
  center: { lat: number; lon: number; aqi: number | null } | null;
  cellKm: number;
  points: AqGridPoint[];
  fetchedAt: string | null;
  source: string;
}

/**
 * Where one EPA band ends and the next starts on the CONTINUOUS field. An
 * interpolated value is rounded to a whole index before it is classified
 * (aqiBand), so the band that starts at 51 starts at 50.5, and so on. The map
 * outlines the bands at these values.
 */
export const AQI_BAND_EDGES: readonly number[] = AQI_SCALE.bands
  .slice(1)
  .map((band) => band.from - 0.5);

/**
 * The grid as one smooth, banded picture for the map: the 7 x 7 readings
 * interpolated onto a finer raster (field-raster.ts), every pixel classified
 * into its EPA band with `aqiBand`, the same function the bubbles, the gauge
 * and the legend use. A reading the model did not return leaves a hole. Null
 * when the grid is unavailable or has too few points to interpolate.
 *
 * Smoother, not more detailed: the data is still the 49 samples.
 */
export function aqFieldRaster(
  grid: AqGridResponse | null | undefined,
  options: { side?: number } = {},
): FieldRaster | null {
  if (!grid?.available) return null;
  const samples = sampleGridFrom(
    grid.points.map((p) => ({ lat: p.lat, lon: p.lon, value: p.aqi })),
  );
  if (!samples || !hasReadings(samples)) return null;
  return buildFieldRaster(samples, {
    classify: (aqi) => AQI_BANDS.indexOf(aqiBand(aqi)),
    tokens: AQI_BANDS.map((band) => AQI_BAND_TOKEN[band]),
    levels: AQI_BAND_EDGES,
    side: options.side,
  });
}

/**
 * Fetch the AQI grid for a coordinate. Resolves to the response body (which may
 * have `available: false`). Rejects on network or non-2xx errors so the caller
 * can decide how to degrade; an aborted request rejects with an AbortError.
 */
export async function fetchAirQualityGrid(options: {
  lat: number;
  lon: number;
  radiusKm?: number;
  n?: number;
  signal?: AbortSignal;
}): Promise<AqGridResponse> {
  // Shared read: one grid per route + 0.05 degree cell + size, however often
  // the card is mounted (LazySection) and however many cards ask at once.
  return workerData.json<AqGridResponse>(
    "air-quality/grid",
    {
      lat: options.lat,
      lon: options.lon,
      radiusKm: options.radiusKm ?? 40,
      n: options.n ?? 7,
    },
    { signal: options.signal },
  );
}

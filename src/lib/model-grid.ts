/**
 * Per-model forecast fields for the full-screen map.
 *
 * The Rust Worker's `/v1/model-grid` returns one model's 3-hourly temperature, precipitation
 * and wind on an n×n grid. This module types that response, turns one variable
 * at one step into a smooth, banded raster (field-raster.ts interpolates
 * between the samples, the legend's bands colour it) and fetches it.
 * Everything but `fetchModelGrid` is pure and unit-tested.
 */

import {
  buildFieldRaster,
  hasReadings,
  sampleGridFrom,
  type FieldRaster,
} from "./field-raster";
import { getMapChip, legendBandIndex, type LayerLegend } from "./map-layers";
import { MODEL_LAYER_VARIABLES, type ModelVariable } from "./map-sources";
import { weatherApiBase } from "./weather-api";

/** The Rust weather backend, used when no override is configured. */
const WORKER_ORIGIN = "https://weather-api.mukoko.com";

export interface ModelGridPoint {
  lat: number;
  lon: number;
  temperature: (number | null)[];
  precipitation: (number | null)[];
  windSpeed: (number | null)[];
  windDirection: (number | null)[];
}

export interface ModelGridResponse {
  available: boolean;
  model: string;
  cellKm: number;
  times: string[];
  points: ModelGridPoint[];
  fetchedAt: string | null;
  reason?: string | null;
}

/** Response field holding each variable's series. */
const SERIES_KEY: Record<
  ModelVariable,
  keyof Pick<ModelGridPoint, "temperature" | "precipitation" | "windSpeed">
> = {
  temperature: "temperature",
  precipitation: "precipitation",
  wind: "windSpeed",
};

/**
 * One model-field chip at one timeline step as a smooth, banded raster: the
 * 7 x 7 values interpolated between the samples, every pixel put in the chip
 * legend's band (`legendBandIndex`, the rule the legend itself uses). A value
 * below the legend's first band (drizzle under 0.1 mm/h) stays clear, and a
 * missing reading leaves a hole, so the map shows nothing there rather than a
 * misleading colour. Null when there is nothing to draw: an unavailable grid,
 * a layer that is not a model field, or a step with no readings.
 *
 * Smoother, not more detailed: the data is still 49 samples of a 9 to 25 km
 * model, 40 km apart.
 */
export function modelFieldRaster(
  grid: ModelGridResponse | null | undefined,
  layerId: string,
  step: number,
  options: { side?: number } = {},
): FieldRaster | null {
  const variable = MODEL_LAYER_VARIABLES[layerId];
  const legend = getMapChip(layerId)?.legend;
  if (!grid?.available || !variable || !legend) return null;

  const key = SERIES_KEY[variable];
  const samples = sampleGridFrom(
    grid.points.map((p) => ({
      lat: p.lat,
      lon: p.lon,
      value: p[key]?.[step] ?? null,
    })),
  );
  if (!samples || !hasReadings(samples)) return null;
  return buildFieldRaster(samples, {
    classify: (value) => legendBandIndex(legend, value),
    tokens: modelLegendTokens(legend),
    levels: legend.segments
      .map((s) => s.from)
      .filter(
        (from): from is number => from !== undefined && Number.isFinite(from),
      ),
    side: options.side,
  });
}

/** CSS custom properties per band, for painting the raster (paint cannot read var()). */
export function modelLegendTokens(legend: LayerLegend | undefined): string[] {
  return (legend?.segments ?? []).map(
    (s) => s.token ?? "--color-text-tertiary",
  );
}

/**
 * Fetches a model grid. Resolves to the body (which may be `available: false`);
 * rejects on network or non-2xx errors and on abort.
 */
export async function fetchModelGrid(options: {
  lat: number;
  lon: number;
  model: string;
  signal?: AbortSignal;
}): Promise<ModelGridResponse> {
  const params = new URLSearchParams({
    lat: options.lat.toFixed(4),
    lon: options.lon.toFixed(4),
    model: options.model,
  });
  const base = weatherApiBase() ?? WORKER_ORIGIN;
  const res = await fetch(`${base}/v1/model-grid?${params.toString()}`, {
    signal: options.signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`model grid HTTP ${res.status}`);
  return (await res.json()) as ModelGridResponse;
}

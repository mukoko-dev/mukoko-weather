/**
 * Per-model forecast fields for the full-screen map.
 *
 * `/api/py/model-grid` returns one model's 3-hourly temperature, precipitation
 * and wind on an n×n grid. This module types that response, turns one variable
 * at one step into coloured square cells (reusing the AQ grid's cell geometry)
 * and fetches it. Everything but `fetchModelGrid` is pure and unit-tested.
 */

import type { FeatureCollection, Polygon } from "geojson";
import { gridToGeoJSON } from "./aq-grid";
import { getMapChip, legendBandIndex, type LayerLegend } from "./map-layers";
import { MODEL_LAYER_VARIABLES, type ModelVariable } from "./map-sources";

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

export interface ModelCellProperties {
  /** Index into the chip legend's segments (the fill colour). */
  band: number;
  value: number;
}

/**
 * Cells for one model-field chip at one timeline step. Points without a value,
 * or below the legend's first band (e.g. drizzle under 0.1 mm/h), are left out
 * so the map shows nothing there rather than a misleading colour.
 */
export function modelGridToGeoJSON(
  grid: ModelGridResponse | null | undefined,
  layerId: string,
  step: number,
): FeatureCollection<Polygon, ModelCellProperties> | null {
  const variable = MODEL_LAYER_VARIABLES[layerId];
  const legend = getMapChip(layerId)?.legend;
  if (!grid?.available || !variable || !legend) return null;

  const key = SERIES_KEY[variable];
  const kept: { lat: number; lon: number; band: number; value: number }[] = [];
  for (const p of grid.points) {
    const value = p[key]?.[step];
    if (value === null || value === undefined) continue;
    const band = legendBandIndex(legend, value);
    if (band < 0) continue;
    kept.push({ lat: p.lat, lon: p.lon, band, value });
  }

  // gridToGeoJSON builds the square cells; only its geometry is used here.
  const cells = gridToGeoJSON(
    kept.map((k) => ({ lat: k.lat, lon: k.lon, aqi: null })),
    grid.cellKm,
  );
  return {
    type: "FeatureCollection",
    features: cells.features.map((f, i) => ({
      type: "Feature",
      geometry: f.geometry,
      properties: { band: kept[i].band, value: kept[i].value },
    })),
  };
}

/** CSS custom properties per band, for the map's fill colour expression. */
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
  const res = await fetch(`/api/py/model-grid?${params.toString()}`, {
    signal: options.signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`model grid HTTP ${res.status}`);
  return (await res.json()) as ModelGridResponse;
}

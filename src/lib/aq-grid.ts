/**
 * Air quality grid helpers for the Air Quality Map card.
 *
 * `/api/py/airquality/grid` returns current US AQI on a regular n×n grid. This
 * module turns those points into square GeoJSON cells (one per grid point) for
 * a MapLibre fill layer, classifies AQI into EPA bands, and fetches the grid.
 * Everything except `fetchAirQualityGrid` is pure and unit-tested.
 */

import type { Feature, FeatureCollection, Polygon } from "geojson";

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
 * CSS custom property per band. The map paints with these resolved to concrete
 * colours (MapLibre paint values cannot read var()). Six bands share five
 * severity tokens, so very_unhealthy and hazardous share the extreme token.
 */
export const AQI_BAND_SEVERITY_TOKEN: Record<AqiBand, string> = {
  good: "--color-severity-low",
  moderate: "--color-severity-moderate",
  usg: "--color-severity-high",
  unhealthy: "--color-severity-severe",
  very_unhealthy: "--color-severity-extreme",
  hazardous: "--color-severity-extreme",
};

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

export interface AqCellProperties {
  aqi: number | null;
  band: AqiBand | null;
}

/** Metres-per-degree constants match the backend (spherical Earth, R = 6371 km). */
const KM_PER_DEG = 111.195;

/**
 * Square polygon cells, one per grid point, centred on the point. `cellKm` is
 * the side length in metres-on-the-ground: longitude spacing is corrected for
 * latitude so cells are square on the map, not stretched.
 *
 * Rings are counter-clockwise (RFC 7946 exterior-ring convention) and closed.
 */
export function gridToGeoJSON(
  points: readonly (Omit<AqGridPoint, "pm2_5"> & { pm2_5?: number | null })[],
  cellKm: number,
): FeatureCollection<Polygon, AqCellProperties> {
  const halfKm = cellKm / 2;
  const halfLatDeg = halfKm / KM_PER_DEG;

  const features: Feature<Polygon, AqCellProperties>[] = points.map((p) => {
    const cosLat = Math.cos((p.lat * Math.PI) / 180);
    // Guard the pole: cos → 0 would divide by zero. Clamp to a tiny positive value.
    const halfLonDeg = halfKm / (KM_PER_DEG * Math.max(cosLat, 1e-6));
    const w = p.lon - halfLonDeg;
    const e = p.lon + halfLonDeg;
    const s = p.lat - halfLatDeg;
    const n = p.lat + halfLatDeg;
    return {
      type: "Feature",
      properties: {
        aqi: p.aqi,
        band: p.aqi === null ? null : aqiBand(p.aqi),
      },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        ],
      },
    };
  });

  return { type: "FeatureCollection", features };
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
  const params = new URLSearchParams({
    lat: options.lat.toFixed(4),
    lon: options.lon.toFixed(4),
    radiusKm: String(options.radiusKm ?? 40),
    n: String(options.n ?? 7),
  });
  const res = await fetch(`/api/py/airquality/grid?${params.toString()}`, {
    signal: options.signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`air quality grid HTTP ${res.status}`);
  return (await res.json()) as AqGridResponse;
}

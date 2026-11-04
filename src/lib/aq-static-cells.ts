/**
 * The air quality grid in the static map's world pixels (#476), so the Air
 * Quality Map card can be a raster picture instead of a MapLibre map (a WebGL
 * context, web workers and about 1.2 MB of script for a card nobody can pan).
 *
 * Two ways to draw it, both pure and both placed with the static map's own
 * world-pixel function:
 *  - `aqStaticField`: the smooth banded picture the full map shows
 *    (`aqFieldRaster`, field-raster.ts): the raster's rectangle and the band
 *    outlines as SVG paths;
 *  - `aqStaticCells`: one square per grid point, the fallback for a browser that
 *    cannot paint the raster to a canvas.
 */

import { aqiBand, type AqGridResponse, type AqiBand } from "@/lib/aq-grid";
import { contourLines, type FieldRaster } from "@/lib/field-raster";
import { worldPixel, worldRect } from "@/lib/static-map";

const px = (n: number) => n.toFixed(1);

/** Metres-per-degree constant matches the backend (spherical Earth, R = 6371 km). */
const KM_PER_DEG = 111.195;

/* ------------------------------------------------------------------------ *
 * The smooth picture
 * ------------------------------------------------------------------------ */

export interface AqStaticField {
  /** Where the raster image goes, in the world pixels of `zoom`. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** One SVG path per band edge (`d`), the thin outlines the full map draws. */
  contours: { level: number; d: string }[];
}

/**
 * The raster's rectangle and its band outlines in world pixels. The rectangle
 * is the raster's extent projected (north and south through Web Mercator, see
 * `worldRect`), the outlines are `contourLines` projected point by point.
 */
export function aqStaticField(
  raster: FieldRaster,
  zoom: number,
): AqStaticField {
  const z = Math.max(0, Math.round(zoom));
  const contours = contourLines(raster).features.map((feature) => ({
    level: feature.properties.level,
    d: feature.geometry.coordinates
      .map((line) =>
        line
          .map(([lon, lat], i) => {
            const { x, y } = worldPixel(lat, lon, z);
            return `${i === 0 ? "M" : "L"}${px(x)} ${px(y)}`;
          })
          .join(""),
      )
      .join(""),
  }));
  return { ...worldRect(raster.extent, z), contours };
}

/* ------------------------------------------------------------------------ *
 * The square cells (fallback)
 * ------------------------------------------------------------------------ */

export interface AqStaticCell {
  /** Stable per grid point, for React keys. */
  id: string;
  band: AqiBand;
  /** SVG `points` attribute, in the world pixels of `zoom`. */
  points: string;
}

/**
 * One square per grid point with a reading, `cellKm` across on the ground
 * (longitude spacing corrected for latitude, so cells are square on the map).
 * Web Mercator keeps squares square, so each cell only needs projecting. A
 * point with no AQI has no band and is left out.
 */
export function aqStaticCells(
  grid: Pick<AqGridResponse, "points" | "cellKm">,
  zoom: number,
): AqStaticCell[] {
  const z = Math.max(0, Math.round(zoom));
  const halfKm = grid.cellKm / 2;
  const halfLat = halfKm / KM_PER_DEG;
  const out: AqStaticCell[] = [];
  grid.points.forEach((point, index) => {
    if (point.aqi === null || !Number.isFinite(point.aqi)) return;
    // Guard the pole: cos -> 0 would divide by zero.
    const cosLat = Math.max(Math.cos((point.lat * Math.PI) / 180), 1e-6);
    const halfLon = halfKm / (KM_PER_DEG * cosLat);
    const corners: [number, number][] = [
      [point.lon - halfLon, point.lat + halfLat], // north-west
      [point.lon + halfLon, point.lat + halfLat], // north-east
      [point.lon + halfLon, point.lat - halfLat], // south-east
      [point.lon - halfLon, point.lat - halfLat], // south-west
    ];
    out.push({
      id: String(index),
      band: aqiBand(point.aqi),
      points: corners
        .map(([lon, lat]) => {
          const { x, y } = worldPixel(lat, lon, z);
          return `${px(x)},${px(y)}`;
        })
        .join(" "),
    });
  });
  return out;
}

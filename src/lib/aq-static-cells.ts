/**
 * The air quality grid as SVG polygons in the static map's world pixels
 * (#476), so the Air Quality Map card can be a raster picture with cells drawn
 * over it instead of a MapLibre map (a WebGL context, web workers and
 * about 1.2 MB of script for a card nobody can pan).
 *
 * Pure: `gridToGeoJSON` already makes square cells that are square on the
 * ground; Web Mercator keeps squares square, so each cell stays a square in
 * world pixels and only needs projecting.
 */

import type { FeatureCollection, Polygon } from "geojson";
import type { AqCellProperties, AqiBand } from "@/lib/aq-grid";
import { worldPixel } from "@/lib/static-map";

export interface AqStaticCell {
  /** Stable per grid point, for React keys. */
  id: string;
  band: AqiBand;
  /** SVG `points` attribute, in the world pixels of `zoom`. */
  points: string;
}

const px = (n: number) => n.toFixed(1);

/**
 * One polygon per cell with a reading. A cell with no AQI has no band and is
 * left out (the map left it unpainted too). The closing point of the GeoJSON
 * ring is dropped: an SVG polygon closes itself.
 */
export function aqStaticCells(
  cells: FeatureCollection<Polygon, AqCellProperties>,
  zoom: number,
): AqStaticCell[] {
  const z = Math.max(0, Math.round(zoom));
  const out: AqStaticCell[] = [];
  cells.features.forEach((feature, index) => {
    const band = feature.properties.band;
    if (!band) return;
    const ring = feature.geometry.coordinates[0] ?? [];
    const open = ring.length > 1 ? ring.slice(0, -1) : ring;
    if (open.length < 3) return;
    const points = open
      .map(([lon, lat]) => {
        const { x, y } = worldPixel(lat, lon, z);
        return `${px(x)},${px(y)}`;
      })
      .join(" ");
    out.push({ id: String(index), band, points });
  });
  return out;
}

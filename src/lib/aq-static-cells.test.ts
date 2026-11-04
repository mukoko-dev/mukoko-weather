/**
 * The air quality grid as SVG polygons for the static map card (#476): the
 * projection into the static map's world pixels, which cells are drawn, and
 * that a cell stays a square after projecting.
 */
import { describe, expect, it } from "vitest";
import { gridToGeoJSON } from "@/lib/aq-grid";
import { aqStaticCells } from "@/lib/aq-static-cells";
import { staticMapTiles, worldPixel } from "@/lib/static-map";

const ZOOM = 9;

const pointsOf = (cell: { points: string }) =>
  cell.points
    .split(" ")
    .map((p) => p.split(",").map(Number) as [number, number]);

describe("aqStaticCells", () => {
  const grid = gridToGeoJSON(
    [
      { lat: -17.83, lon: 31.05, aqi: 42 },
      { lat: -17.83, lon: 31.15, aqi: 120 },
      { lat: -17.73, lon: 31.05, aqi: null },
    ],
    11,
  );

  it("draws one polygon per cell that has a reading, banded by EPA category", () => {
    const cells = aqStaticCells(grid, ZOOM);
    expect(cells.map((c) => c.band)).toEqual(["good", "usg"]);
    // The unreadable cell (null AQI) is not painted, like on the full map.
    expect(cells).toHaveLength(2);
  });

  it("projects each corner with the static map's own world-pixel function", () => {
    const [cell] = aqStaticCells(grid, ZOOM);
    const ring = grid.features[0].geometry.coordinates[0];
    const expected = ring.slice(0, -1).map(([lon, lat]) => {
      const { x, y } = worldPixel(lat, lon, ZOOM);
      return [Number(x.toFixed(1)), Number(y.toFixed(1))];
    });
    expect(pointsOf(cell)).toEqual(expected);
  });

  it("leaves the ring open (an SVG polygon closes itself): four corners, not five", () => {
    const [cell] = aqStaticCells(grid, ZOOM);
    expect(pointsOf(cell)).toHaveLength(4);
  });

  it("keeps a cell square (Web Mercator is conformal) and about cellKm across", () => {
    const [cell] = aqStaticCells(grid, ZOOM);
    const [a, b, c] = pointsOf(cell);
    const width = b[0] - a[0];
    const height = a[1] - c[1];
    expect(width).toBeGreaterThan(0);
    expect(Math.abs(width - height) / width).toBeLessThan(0.01);
    // 11 km at zoom 9 (512 px tiles) at 17.8 degrees south is about 76 px.
    const kmPerPixel =
      (40075.017 * Math.cos((17.83 * Math.PI) / 180)) / (512 * 2 ** ZOOM);
    expect(width * kmPerPixel).toBeGreaterThan(10.5);
    expect(width * kmPerPixel).toBeLessThan(11.5);
  });

  it("lands inside the static picture's tiles for the grid's own centre", () => {
    const picture = staticMapTiles({
      lat: -17.83,
      lon: 31.05,
      zoom: ZOOM,
      style: "streets-v2",
      apiKey: "k",
    });
    const [minX, minY, w, h] = picture.viewBox.split(" ").map(Number);
    const [cell] = aqStaticCells(grid, ZOOM);
    const [a, , c] = pointsOf(cell);
    // The first cell is centred on the picture's centre.
    expect((a[0] + pointsOf(cell)[1][0]) / 2).toBeCloseTo(picture.cx, 0);
    expect(a[0]).toBeGreaterThan(minX);
    expect(c[1]).toBeGreaterThan(minY);
    expect(a[0]).toBeLessThan(minX + w);
    expect(a[1]).toBeLessThan(minY + h);
  });

  it("drops a degenerate ring instead of drawing nonsense", () => {
    const broken = {
      type: "FeatureCollection" as const,
      features: [
        {
          type: "Feature" as const,
          properties: { aqi: 10, band: "good" as const },
          geometry: { type: "Polygon" as const, coordinates: [[[31, -17]]] },
        },
      ],
    };
    expect(aqStaticCells(broken, ZOOM)).toEqual([]);
  });

  it("gives each cell a distinct key", () => {
    const cells = aqStaticCells(grid, ZOOM);
    expect(new Set(cells.map((c) => c.id)).size).toBe(cells.length);
  });
});

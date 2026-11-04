/**
 * The air quality grid in the static map's world pixels (#476): the smooth
 * picture's rectangle and outlines, and the square-cell fallback.
 */
import { describe, expect, it } from "vitest";
import { aqFieldRaster, type AqGridResponse } from "@/lib/aq-grid";
import { aqStaticCells, aqStaticField } from "@/lib/aq-static-cells";
import { staticMapTiles, worldPixel, worldRect } from "@/lib/static-map";

const ZOOM = 9;
const LAT = -17.83;
const LON = 31.05;

/** The Worker's 7 x 7 grid around Harare, 0.1 degrees apart, AQI varied across it. */
function grid(
  aqi: (i: number, j: number) => number | null = (i, j) =>
    20 + ((i * j + 9) % 30) * 8,
): AqGridResponse {
  const points = [];
  for (let i = 3; i >= -3; i--)
    for (let j = -3; j <= 3; j++)
      points.push({
        lat: LAT + i * 0.1,
        lon: LON + j * 0.1,
        aqi: aqi(i, j),
        pm2_5: 10,
      });
  return {
    available: true,
    center: { lat: LAT, lon: LON, aqi: 52 },
    cellKm: 11,
    points,
    fetchedAt: "2026-11-04T12:00:00Z",
    source: "CAMS",
  };
}

const numbersOf = (d: string) =>
  [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map(Number);

describe("aqStaticField: the smooth picture's rectangle and outlines", () => {
  const raster = aqFieldRaster(grid())!;
  const field = aqStaticField(raster, ZOOM);

  it("places the image at the raster's extent through the static map's projection", () => {
    expect(field).toMatchObject(worldRect(raster.extent, ZOOM));
    expect(field.width).toBeGreaterThan(0);
    expect(field.height).toBeGreaterThan(0);
  });

  it("keeps the picture's own proportions: the raster is built evenly in Mercator y, so the rectangle matches its pixels", () => {
    expect(field.width / field.height).toBeCloseTo(
      raster.width / raster.height,
      1,
    );
  });

  it("is centred on the grid's centre", () => {
    const centre = worldPixel(LAT, LON, ZOOM);
    expect(field.x + field.width / 2).toBeCloseTo(centre.x, 0);
    // Mercator, not linear latitude: close to the centre, but not exact.
    expect(Math.abs(field.y + field.height / 2 - centre.y)).toBeLessThan(2);
  });

  it("lands inside the static picture's tiles", () => {
    const picture = staticMapTiles({
      lat: LAT,
      lon: LON,
      zoom: ZOOM,
      style: "streets-v2",
      apiKey: "k",
    });
    const [minX, minY, w, h] = picture.viewBox.split(" ").map(Number);
    // The picture shows about 400 world pixels; the grid is wider than that.
    expect(field.x).toBeLessThan(minX);
    expect(field.x + field.width).toBeGreaterThan(minX + w);
    expect(field.y).toBeLessThan(minY);
    expect(field.y + field.height).toBeGreaterThan(minY + h);
  });

  it("draws one outline path per band edge that is crossed, inside the rectangle", () => {
    expect(field.contours.length).toBeGreaterThan(0);
    for (const contour of field.contours) {
      expect(contour.d.startsWith("M")).toBe(true);
      const values = numbersOf(contour.d);
      for (let k = 0; k < values.length; k += 2) {
        expect(values[k]).toBeGreaterThanOrEqual(field.x - 1);
        expect(values[k]).toBeLessThanOrEqual(field.x + field.width + 1);
        expect(values[k + 1]).toBeGreaterThanOrEqual(field.y - 1);
        expect(values[k + 1]).toBeLessThanOrEqual(field.y + field.height + 1);
      }
    }
    expect(new Set(field.contours.map((c) => c.level)).size).toBe(
      field.contours.length,
    );
  });

  it("has no outline for a flat field", () => {
    const flat = aqStaticField(aqFieldRaster(grid(() => 30))!, ZOOM);
    expect(flat.contours).toEqual([]);
  });
});

describe("aqStaticCells: the square-cell fallback", () => {
  const withGaps = grid((i, j) =>
    i === 3 && j === -3 ? null : 40 + (i + j) * 20,
  );

  it("draws one polygon per grid point that has a reading, banded by EPA category", () => {
    const cells = aqStaticCells(withGaps, ZOOM);
    expect(cells).toHaveLength(48);
    expect(cells.every((c) => c.band.length > 0)).toBe(true);
    const centre = cells.find((c) => c.id === "24")!; // i = 0, j = 0: AQI 40
    expect(centre.band).toBe("good");
  });

  it("projects each corner with the static map's own world-pixel function", () => {
    const one = {
      cellKm: 11,
      points: [{ lat: LAT, lon: LON, aqi: 42, pm2_5: 1 }],
    };
    const [cell] = aqStaticCells(one, ZOOM);
    const corners = cell.points.split(" ").map((p) => p.split(",").map(Number));
    expect(corners).toHaveLength(4);
    const halfLat = 5.5 / 111.195;
    const halfLon = 5.5 / (111.195 * Math.cos((LAT * Math.PI) / 180));
    const expected = [
      [LON - halfLon, LAT + halfLat],
      [LON + halfLon, LAT + halfLat],
      [LON + halfLon, LAT - halfLat],
      [LON - halfLon, LAT - halfLat],
    ].map(([lon, lat]) => {
      const { x, y } = worldPixel(lat, lon, ZOOM);
      return [Number(x.toFixed(1)), Number(y.toFixed(1))];
    });
    expect(corners).toEqual(expected);
  });

  it("keeps a cell square (Web Mercator is conformal) and about cellKm across", () => {
    const [cell] = aqStaticCells(
      { cellKm: 11, points: [{ lat: LAT, lon: LON, aqi: 42, pm2_5: 1 }] },
      ZOOM,
    );
    const [a, b, c] = cell.points
      .split(" ")
      .map((p) => p.split(",").map(Number));
    const width = b[0] - a[0];
    const height = c[1] - a[1];
    expect(Math.abs(width - height) / width).toBeLessThan(0.01);
    const kmPerPixel =
      (40075.017 * Math.cos((LAT * Math.PI) / 180)) / (512 * 2 ** ZOOM);
    expect(width * kmPerPixel).toBeGreaterThan(10.5);
    expect(width * kmPerPixel).toBeLessThan(11.5);
  });

  it("leaves out a point with no usable reading, and gives each cell a distinct key", () => {
    const cells = aqStaticCells(
      {
        cellKm: 11,
        points: [
          { lat: LAT, lon: LON, aqi: null, pm2_5: 1 },
          { lat: LAT, lon: LON + 0.1, aqi: Number.NaN, pm2_5: 1 },
          { lat: LAT, lon: LON + 0.2, aqi: 80, pm2_5: 1 },
          { lat: LAT, lon: LON + 0.3, aqi: 90, pm2_5: 1 },
        ],
      },
      ZOOM,
    );
    expect(cells.map((c) => c.id)).toEqual(["2", "3"]);
  });
});

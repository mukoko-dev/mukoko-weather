import { describe, it, expect } from "vitest";
import {
  STATIC_TILE_SIZE,
  STATIC_VIEW_SIZE,
  allTilesFailed,
  rasterTileUrl,
  staticMapTiles,
  wantsRetinaTiles,
  worldPixel,
} from "./static-map";

const harare = { lat: -17.8292, lon: 31.0522 };

describe("worldPixel", () => {
  it("puts (0, 0) in the middle of the world", () => {
    const p = worldPixel(0, 0, 0);
    expect(p.x).toBeCloseTo(STATIC_TILE_SIZE / 2);
    expect(p.y).toBeCloseTo(STATIC_TILE_SIZE / 2);
  });

  it("matches the standard slippy-map tile for Harare at z10", () => {
    // 512 px tiles at zoom z index like 256 px tiles at the same z.
    const p = worldPixel(harare.lat, harare.lon, 10);
    expect(Math.floor(p.x / STATIC_TILE_SIZE)).toBe(600);
    expect(Math.floor(p.y / STATIC_TILE_SIZE)).toBe(563);
  });

  it("clamps the poles instead of returning Infinity", () => {
    expect(Number.isFinite(worldPixel(90, 0, 3).y)).toBe(true);
    expect(Number.isFinite(worldPixel(-90, 0, 3).y)).toBe(true);
  });
});

describe("staticMapTiles", () => {
  const map = staticMapTiles({
    ...harare,
    zoom: 10,
    style: "streets-v2",
    apiKey: "k",
  });

  it("returns a 2x2 block that contains the whole view square", () => {
    expect(map.tiles).toHaveLength(4);
    const minX = Math.min(...map.tiles.map((t) => t.x));
    const minY = Math.min(...map.tiles.map((t) => t.y));
    const half = STATIC_VIEW_SIZE / 2;
    expect(map.cx - half).toBeGreaterThanOrEqual(minX);
    expect(map.cy - half).toBeGreaterThanOrEqual(minY);
    expect(map.cx + half).toBeLessThanOrEqual(minX + 2 * STATIC_TILE_SIZE);
    expect(map.cy + half).toBeLessThanOrEqual(minY + 2 * STATIC_TILE_SIZE);
  });

  it("centres the viewBox on the location", () => {
    const [x, y, w, h] = map.viewBox.split(" ").map(Number);
    expect(x + w / 2).toBeCloseTo(map.cx);
    expect(y + h / 2).toBeCloseTo(map.cy);
    expect(w).toBe(STATIC_VIEW_SIZE);
    expect(h).toBe(STATIC_VIEW_SIZE);
  });

  it("builds MapTiler raster tile URLs for the requested style", () => {
    for (const t of map.tiles) {
      expect(t.href).toMatch(
        /^https:\/\/api\.maptiler\.com\/maps\/streets-v2\/10\/\d+\/\d+\.png\?key=k$/,
      );
    }
  });

  it("wraps columns across the antimeridian", () => {
    const m = staticMapTiles({
      lat: 0,
      lon: 179.99,
      zoom: 3,
      style: "s",
      apiKey: "k",
    });
    const cols = m.tiles.map((t) => Number(t.href.split("/")[6]));
    expect(cols.every((c) => c >= 0 && c < 8)).toBe(true);
    expect(cols).toContain(0);
  });

  it("never asks for a row outside the world", () => {
    const m = staticMapTiles({
      lat: 85,
      lon: 0,
      zoom: 4,
      style: "s",
      apiKey: "k",
    });
    const rows = m.tiles.map((t) => Number(t.href.split("/")[7].split(".")[0]));
    expect(rows.every((r) => r >= 0 && r < 16)).toBe(true);
  });

  it("drops whitespace around the key (the deployed value ends in a newline)", () => {
    expect(rasterTileUrl("s", 1, 0, 0, "abc\n")).toMatch(/key=abc$/);
    expect(rasterTileUrl("s", 1, 0, 0, " abc ")).toMatch(/key=abc$/);
  });

  it("covers the view with the only tile at zoom 0", () => {
    const m = staticMapTiles({
      lat: 0,
      lon: -170,
      zoom: 0,
      style: "s",
      apiKey: "k",
    });
    expect(m.tiles).toHaveLength(1);
    expect(m.tiles[0].x).toBe(0);
    expect(m.cx).toBeGreaterThanOrEqual(0);
    expect(m.cx).toBeLessThan(STATIC_TILE_SIZE);
  });

  it("encodes the key", () => {
    expect(rasterTileUrl("s", 1, 0, 0, "a b")).toContain("key=a%20b");
  });
});

describe("retina tiles", () => {
  it("adds the @2x suffix without changing the geometry", () => {
    const base = { ...harare, zoom: 10, style: "streets-v2", apiKey: "k" };
    const one = staticMapTiles(base);
    const two = staticMapTiles({ ...base, retina: true });
    expect(two.viewBox).toBe(one.viewBox);
    expect(two.tiles.map((t) => [t.x, t.y])).toEqual(
      one.tiles.map((t) => [t.x, t.y]),
    );
    for (const t of two.tiles) expect(t.href).toMatch(/\d+@2x\.png\?key=k$/);
    for (const t of one.tiles) expect(t.href).not.toContain("@2x");
  });

  it("asks for them only on dense screens", () => {
    expect(wantsRetinaTiles(1)).toBe(false);
    expect(wantsRetinaTiles(undefined)).toBe(false);
    expect(wantsRetinaTiles(1.5)).toBe(true);
    expect(wantsRetinaTiles(3)).toBe(true);
  });
});

describe("allTilesFailed", () => {
  const map = staticMapTiles({ ...harare, zoom: 10, style: "s", apiKey: "k" });

  it("is false until every tile has failed", () => {
    expect(allTilesFailed(map, new Set())).toBe(false);
    const hrefs = map.tiles.map((t) => t.href);
    expect(allTilesFailed(map, new Set(hrefs.slice(0, 3)))).toBe(false);
    expect(allTilesFailed(map, new Set(hrefs))).toBe(true);
  });

  it("ignores failures of tiles from another style or density", () => {
    const dark = staticMapTiles({
      ...harare,
      zoom: 10,
      style: "d",
      apiKey: "k",
    });
    expect(allTilesFailed(map, new Set(dark.tiles.map((t) => t.href)))).toBe(
      false,
    );
  });
});

describe("coverage near the poles", () => {
  /** The view square must lie inside the block of tiles that is drawn. */
  function covered(lat: number, lon: number, zoom: number) {
    const m = staticMapTiles({ lat, lon, zoom, style: "s", apiKey: "k" });
    const [vx, vy, w, h] = m.viewBox.split(" ").map(Number);
    const minX = Math.min(...m.tiles.map((t) => t.x));
    const minY = Math.min(...m.tiles.map((t) => t.y));
    const maxX = Math.max(...m.tiles.map((t) => t.x)) + STATIC_TILE_SIZE;
    const maxY = Math.max(...m.tiles.map((t) => t.y)) + STATIC_TILE_SIZE;
    const world = STATIC_TILE_SIZE * 2 ** Math.round(zoom);
    return {
      m,
      inside: vx >= minX && vy >= minY && vx + w <= maxX && vy + h <= maxY,
      withinWorld: vy >= 0 && vy + h <= world,
    };
  }

  it("covers the view at lat 85, z10", () => {
    const { inside, withinWorld } = covered(85, 0, 10);
    expect(inside).toBe(true);
    expect(withinWorld).toBe(true);
  });

  it("keeps the view inside the world at the Mercator limit and beyond", () => {
    for (const lat of [85.05, 89, 90, -85, -85.05, -89, -90]) {
      const { inside, withinWorld } = covered(lat, 12.3, 10);
      expect(withinWorld).toBe(true);
      expect(inside).toBe(true);
    }
  });

  it("keeps the marker on the real position when the view had to shift", () => {
    const { m } = covered(85.05, 0, 10);
    const [, vy, , h] = m.viewBox.split(" ").map(Number);
    // The marker sits near the top edge, inside the (shifted) view.
    expect(m.cy).toBeGreaterThanOrEqual(vy);
    expect(m.cy).toBeLessThanOrEqual(vy + h);
    expect(m.cy).toBeLessThan(STATIC_VIEW_SIZE / 2);
  });

  it("covers the view everywhere on a coarse sweep of lat/lon/zoom", () => {
    // From z1: the single tile of z0 cannot repeat to cover a view that
    // straddles the antimeridian (the preview uses z10).
    for (let zoom = 1; zoom <= 14; zoom += 1) {
      for (let lat = -90; lat <= 90; lat += 15) {
        for (let lon = -180; lon <= 180; lon += 45) {
          const { inside, withinWorld } = covered(lat, lon, zoom);
          expect(inside, `${lat},${lon} z${zoom}`).toBe(true);
          expect(withinWorld, `${lat},${lon} z${zoom}`).toBe(true);
        }
      }
    }
  });
});

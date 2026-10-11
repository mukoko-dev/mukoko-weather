import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  STATIC_TILE_SIZE,
  STATIC_VIEW_SIZE,
  rasterTileUrl,
  staticMapTiles,
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

  it("encodes the key", () => {
    expect(rasterTileUrl("s", 1, 0, 0, "a b")).toContain("key=a%20b");
  });
});

describe("MapPreview (#266)", () => {
  const source = readFileSync(
    resolve(__dirname, "../components/weather/map/MapPreview.tsx"),
    "utf-8",
  );

  it("draws a static tile picture instead of mounting MapLibre", () => {
    expect(source).not.toContain("MapLibreMap");
    expect(source).not.toContain("maplibre-gl");
    expect(source).toContain("staticMapTiles(");
    expect(source).toContain("<image");
  });

  it("follows the theme and keeps the attribution", () => {
    expect(source).toContain('isDark ? "streets-v2-dark" : "streets-v2"');
    expect(source).toContain("© MapTiler © OpenStreetMap");
  });

  it("stays a link to the full map with an accessible name", () => {
    expect(source).toContain("href={`/${location.slug}/map`}");
    expect(source).toContain(
      "aria-label={`Open weather map for ${location.name}`}",
    );
    expect(source).toContain('aria-hidden="true"');
  });

  it("uses tokens, not hardcoded colours or inline styles", () => {
    expect(source).not.toMatch(/["']#[0-9a-fA-F]{3,8}["']/);
    expect(source).not.toContain("style={{");
    expect(source).toContain("fill-primary");
  });
});

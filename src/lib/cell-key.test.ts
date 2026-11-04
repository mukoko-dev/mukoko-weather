import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { CELL_GRID_DEG, cellKey } from "./cell-key";

interface Fixture {
  gridDeg: number;
  vectors: { lat: number; lon: number; key: string }[];
}

// The vectors `weather_core::geo::cell_key` (the Worker) is pinned to, so the
// browser's shared store and the Worker's caches can never use different cells.
const fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../tests/fixtures/weather-cache-keys.json"),
    "utf-8",
  ),
) as Fixture;

describe("cellKey (0.05 degree cell)", () => {
  it("uses the fixture's grid", () => {
    expect(CELL_GRID_DEG).toBe(fixture.gridDeg);
  });

  it.each(fixture.vectors)("$lat,$lon is $key", ({ lat, lon, key }) => {
    expect(cellKey(lat, lon)).toBe(key);
  });

  it("two points in one cell share a key; points a cell apart do not", () => {
    expect(cellKey(-17.8292, 31.0522)).toBe(cellKey(-17.8282, 31.0522));
    expect(cellKey(-17.8292, 31.0522)).not.toBe(cellKey(-17.9, 31.0522));
  });
});

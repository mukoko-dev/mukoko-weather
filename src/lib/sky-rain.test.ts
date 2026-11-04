import { describe, expect, it } from "vitest";
import { RAIN_TILE_H, RAIN_TILE_W, rainDrops } from "./sky-rain";

describe("rainDrops", () => {
  const drops = rainDrops();

  it("is deterministic: the same drops every time, server and client", () => {
    expect(rainDrops()).toEqual(drops);
    expect(JSON.stringify(rainDrops())).toBe(JSON.stringify(drops));
  });

  it("has one drop per cell of a 6 x 6 grid", () => {
    expect(drops).toHaveLength(36);
  });

  it("keeps every drop wholly inside the tile, so no drop is cut by a tile edge (no seam on the loop)", () => {
    for (const d of drops) {
      for (const [x, y] of [
        [d.x1, d.y1],
        [d.x2, d.y2],
      ]) {
        expect(x).toBeGreaterThanOrEqual(1);
        expect(x).toBeLessThanOrEqual(RAIN_TILE_W - 1);
        expect(y).toBeGreaterThanOrEqual(1);
        expect(y).toBeLessThanOrEqual(RAIN_TILE_H - 1);
      }
    }
  });

  it("falls downward and leans one way, with a length between 16 and 34 px", () => {
    for (const d of drops) {
      expect(d.y2).toBeGreaterThan(d.y1);
      expect(d.x2).toBeLessThanOrEqual(d.x1);
      const length = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
      expect(length).toBeGreaterThan(15);
      expect(length).toBeLessThan(36);
    }
  });

  it("gives every drop its own cell: no two drops' boxes touch", () => {
    const box = (d: (typeof drops)[number]) => ({
      l: Math.min(d.x1, d.x2),
      r: Math.max(d.x1, d.x2),
      t: Math.min(d.y1, d.y2),
      b: Math.max(d.y1, d.y2),
    });
    for (let i = 0; i < drops.length; i++) {
      for (let j = i + 1; j < drops.length; j++) {
        const a = box(drops[i]);
        const b = box(drops[j]);
        const apart = a.r < b.l || b.r < a.l || a.b < b.t || b.b < a.t;
        expect(apart, `${i} and ${j}`).toBe(true);
      }
    }
  });

  it("varies: far drops are shorter and fainter, and the opacities stay in 0.45..1", () => {
    const opacities = drops.map((d) => d.opacity);
    expect(Math.min(...opacities)).toBeGreaterThanOrEqual(0.45);
    expect(Math.max(...opacities)).toBeLessThanOrEqual(1);
    // Rounded to one decimal, so a handful of distinct steps.
    expect(new Set(opacities).size).toBeGreaterThan(4);
    const longest = [...drops].sort((a, b) => b.y2 - b.y1 - (a.y2 - a.y1))[0];
    const shortest = [...drops].sort((a, b) => a.y2 - a.y1 - (b.y2 - b.y1))[0];
    expect(longest.opacity).toBeGreaterThan(shortest.opacity);
  });
});

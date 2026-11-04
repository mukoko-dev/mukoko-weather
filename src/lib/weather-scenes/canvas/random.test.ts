import { describe, expect, it } from "vitest";
import { bestCandidate, between, clamp, seeded } from "./random";

describe("seeded", () => {
  it("gives the same numbers for the same seed and different ones for another", () => {
    const a = seeded(42);
    const b = seeded(42);
    const c = seeded(43);
    const xs = Array.from({ length: 50 }, () => a());
    expect(Array.from({ length: 50 }, () => b())).toEqual(xs);
    expect(Array.from({ length: 50 }, () => c())).not.toEqual(xs);
  });

  it("stays in [0, 1) and is spread out", () => {
    const r = seeded(7);
    const xs = Array.from({ length: 5000 }, () => r());
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.47);
    expect(mean).toBeLessThan(0.53);
  });
});

describe("between and clamp", () => {
  it("stay inside their bounds", () => {
    const r = seeded(1);
    for (let i = 0; i < 500; i++) {
      const v = between(r, 3, 9);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThan(9);
    }
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-5, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
  });
});

describe("bestCandidate", () => {
  const W = 393;
  const H = 640;

  it("returns the points asked for, inside the box, the same for the same seed", () => {
    const pts = bestCandidate(60, W, H, seeded(5));
    expect(pts).toHaveLength(60);
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThan(W);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThan(H);
    }
    expect(bestCandidate(60, W, H, seeded(5))).toEqual(pts);
    expect(bestCandidate(60, W, H, seeded(6))).not.toEqual(pts);
    expect(bestCandidate(0, W, H, seeded(5))).toEqual([]);
  });

  it("spreads points more evenly than plain random, but not on a grid", () => {
    const nearest = (pts: { x: number; y: number }[]) => {
      let total = 0;
      for (const p of pts) {
        let m = Infinity;
        for (const q of pts) {
          if (q === p) continue;
          m = Math.min(m, Math.hypot(p.x - q.x, p.y - q.y));
        }
        total += m;
      }
      return total / pts.length;
    };
    let best = 0;
    let plain = 0;
    const runs = 30;
    for (let s = 1; s <= runs; s++) {
      best += nearest(bestCandidate(60, W, H, seeded(s)));
      const r = seeded(1000 + s);
      plain += nearest(
        Array.from({ length: 60 }, () => ({ x: r() * W, y: r() * H })),
      );
    }
    expect(best / runs).toBeGreaterThan((plain / runs) * 1.2);
    // Irregular: the nearest-neighbour distances are not all alike (a grid has one value).
    const pts = bestCandidate(60, W, H, seeded(3));
    const ds = pts.map((p) =>
      Math.min(
        ...pts
          .filter((q) => q !== p)
          .map((q) => Math.hypot(p.x - q.x, p.y - q.y)),
      ),
    );
    expect(Math.max(...ds) - Math.min(...ds)).toBeGreaterThan(5);
  });
});

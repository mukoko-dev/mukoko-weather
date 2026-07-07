import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { prepareFeasibilityData, categoryChartColor } from "./FeasibilityChart";
import type { FeasibilityPoint } from "@/lib/activity-feasibility";

const source = readFileSync(resolve(__dirname, "FeasibilityChart.tsx"), "utf-8");

describe("prepareFeasibilityData", () => {
  it("maps points to HH:00 labels + scores", () => {
    const points: FeasibilityPoint[] = [
      { time: "2026-07-07T06:00:00", score: 75, level: "good" },
      { time: "2026-07-07T14:00:00", score: 25, level: "poor" },
    ];
    const data = prepareFeasibilityData(points);
    expect(data).toEqual([
      { label: "06:00", score: 75 },
      { label: "14:00", score: 25 },
    ]);
  });
});

describe("categoryChartColor", () => {
  it("maps every category to a mineral color CSS custom property", () => {
    expect(categoryChartColor("farming")).toBe("var(--mineral-malachite)");
    expect(categoryChartColor("mining")).toBe("var(--mineral-terracotta)");
    expect(categoryChartColor("travel")).toBe("var(--mineral-cobalt)");
    expect(categoryChartColor("tourism")).toBe("var(--mineral-tanzanite)");
    expect(categoryChartColor("sports")).toBe("var(--mineral-gold)");
    expect(categoryChartColor("casual")).toBe("var(--color-primary)");
  });

  it("never returns a hardcoded hex value", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{6}/);
  });
});

describe("FeasibilityChart — structure", () => {
  it("builds on the shared TimeSeriesChart base (layered architecture)", () => {
    expect(source).toContain('from "./TimeSeriesChart"');
    expect(source).toContain("<TimeSeriesChart");
  });

  it("uses a fixed 0–100 axis labeled with rating words", () => {
    expect(source).toContain("min: 0");
    expect(source).toContain("max: 100");
    expect(source).toContain("scoreLabel");
  });

  it("hides itself with fewer than 2 points", () => {
    expect(source).toContain("if (data.length < 2) return null");
  });
});

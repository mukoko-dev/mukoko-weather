import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (f: string) => readFileSync(resolve(__dirname, f), "utf-8");

const FILES = [
  "AgricultureCharts.tsx",
  "AgricultureBriefing.tsx",
  "AgricultureCropAdvice.tsx",
  "AgricultureHistory.tsx",
  "CropCalendarTable.tsx",
  "charts/RainEtChart.tsx",
  "charts/WaterBalanceChart.tsx",
  "charts/SoilMoistureChart.tsx",
  "charts/SoilTemperatureChart.tsx",
  "charts/SprayWindowChart.tsx",
];

describe("agriculture page components", () => {
  it("use tokens only, no inline styles, no lint suppressions", () => {
    for (const f of FILES) {
      const src = read(f);
      expect(src, f).not.toMatch(/#[0-9a-fA-F]{6}\b/);
      expect(src, f).not.toMatch(/rgba?\(/);
      expect(src, f).not.toContain("style={{");
      expect(src, f).not.toContain("eslint-disable");
    }
  });

  it("new charts build on TimeSeriesChart with CSS-variable colours", () => {
    for (const f of FILES.filter((x) => x.startsWith("charts/"))) {
      const src = read(f);
      expect(src, f).toContain('from "./TimeSeriesChart"');
      expect(src, f).toContain("var(--");
    }
  });

  it("the chart stack reuses GDDChart and skips empty series", () => {
    const src = read("AgricultureCharts.tsx");
    expect(src).toContain('seriesKeys={["gddMaize"]}');
    expect(src).toContain("hasSeries(rows, b.keys)");
  });

  it("sections are labelled by their headings", () => {
    for (const [f, id] of [
      ["AgricultureBriefing.tsx", "agri-briefing"],
      ["AgricultureCropAdvice.tsx", "agri-crops"],
      ["AgricultureHistory.tsx", "agri-history"],
      ["CropCalendarTable.tsx", "agri-calendar"],
    ]) {
      const src = read(f);
      expect(src, f).toContain(`aria-labelledby="${id}"`);
      expect(src, f).toContain(`id="${id}"`);
    }
  });

  it("the briefing is signed-in only, briefing mode, through the proxy client", () => {
    const src = read("AgricultureBriefing.tsx");
    expect(src).toContain('"briefing"');
    expect(src).toContain("fetchAgriAI(body)");
    expect(src).toContain("ShamwariSignInCTA");
    expect(src).not.toContain("/api/py/ai");
  });

  it("history compares /api/py/history with /api/py/normals", () => {
    const src = read("AgricultureHistory.tsx");
    expect(src).toContain("/api/py/history?location=");
    expect(src).toContain("days=30");
    expect(src).toContain("/api/py/normals?lat=");
  });

  it("GDDChart can draw a subset of its series", () => {
    expect(read("charts/GDDChart.tsx")).toContain("seriesKeys");
  });
});

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

  it("history compares /api/py/history with the Worker's normals", () => {
    const src = read("AgricultureHistory.tsx");
    expect(src).toContain('"history"');
    expect(src).toContain("location=${encodeURIComponent(slug)}&days=30");
    expect(src).toContain("historyFetchOptions(30)");
    expect(src).toContain('"normals"');
    expect(src).not.toContain("/api/py/normals");
  });

  it("the briefing spends no model call without crops or while data is unavailable", () => {
    const src = read("AgricultureBriefing.tsx");
    expect(src).toContain(
      "const wantsAI = signedIn && enabled && crops.length > 0;",
    );
    expect(src).toContain('openMyWeather("activities")');
  });

  it("history loads independently of normals and compares against the window mean", () => {
    const src = read("AgricultureHistory.tsx");
    expect(src).toContain(
      "const loading = history === null || summary === undefined;",
    );
    expect(src).toContain("averageNormals(start, end)");
    expect(src).toContain("date=${date}");
    expect(src).toContain("not a gauge");
  });

  it("history says so when it is partial or failed, with a retry", () => {
    const src = read("AgricultureHistory.tsx");
    // The answer's own flags are read, not just its data.
    expect(src).toContain("readHistoryAnswer(await res.json())");
    expect(src).toContain("degraded: answer.degraded");
    expect(src).toContain("DEGRADED_NOTE");
    expect(src).toContain("HISTORY_FAILED_NOTE");
    // A failed request is "failed", not an empty history.
    expect(src).toContain("if (!res.ok) throw new Error(");
    expect(src).toContain("failed: true");
    // The retry reruns the effect.
    expect(src).toContain("setAttempt((n) => n + 1)");
    expect(src).toContain("[slug, lat, lon, attempt]");
    // Never blames the archive lag for it.
    expect(src).not.toContain("lagNote");
  });

  it("crop advice tells apart no crops from nothing to act on", () => {
    const src = read("AgricultureCropAdvice.tsx");
    expect(src).toContain("crops.length > 0 && advice.length === 0");
  });

  it("GDDChart can draw a subset of its series", () => {
    expect(read("charts/GDDChart.tsx")).toContain("seriesKeys");
  });
});

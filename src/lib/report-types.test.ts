/**
 * Tests for report-types.ts — the shared id/label/icon source for community
 * weather reports, consumed by both WeatherReportModal and RecentReports so
 * the two surfaces of this feature can't silently drift from each other.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { REPORT_TYPES, getReportTypeInfo } from "./report-types";

/** The Workers' allowlist: `REPORT_TYPES` in `weather_core::community`. */
function workerReportTypes(): string[] {
  const source = readFileSync(
    resolve(__dirname, "../../workers/crates/weather-core/src/community.rs"),
    "utf-8",
  );
  const block = /pub const REPORT_TYPES: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(
    source,
  );
  if (!block) throw new Error("REPORT_TYPES not found in community.rs");
  const ids = [...block[2].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  expect(ids).toHaveLength(Number(block[1]));
  return ids;
}

describe("REPORT_TYPES", () => {
  it("has 13 report types", () => {
    expect(REPORT_TYPES).toHaveLength(13);
  });

  it("matches the Workers' allowlist (weather_core::community::REPORT_TYPES)", () => {
    const ids = REPORT_TYPES.map((t) => t.id).sort();
    expect(ids).toEqual([...workerReportTypes()].sort());
    expect(ids).toEqual(
      [
        "light-rain",
        "heavy-rain",
        "thunderstorm",
        "hail",
        "flooding",
        "strong-wind",
        "clear-skies",
        "cloudy",
        "fog",
        "mist",
        "haze",
        "dust",
        "frost",
      ].sort(),
    );
  });

  it("every type has a non-empty label and an icon component", () => {
    for (const type of REPORT_TYPES) {
      expect(type.label.length).toBeGreaterThan(0);
      expect(type.icon).toBeDefined();
    }
  });

  it("has no duplicate ids", () => {
    const ids = REPORT_TYPES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("getReportTypeInfo", () => {
  it("returns the matching entry for a known id", () => {
    expect(getReportTypeInfo("frost")?.label).toBe("Frost");
  });

  it("returns undefined for an unknown id", () => {
    expect(getReportTypeInfo("unknown-type")).toBeUndefined();
  });
});

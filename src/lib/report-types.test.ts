/**
 * Tests for report-types.ts — the shared id/label/icon source for community
 * weather reports, consumed by both WeatherReportModal and RecentReports so
 * the two surfaces of this feature can't silently drift from each other.
 */
import { describe, it, expect } from "vitest";
import { REPORT_TYPES, getReportTypeInfo } from "./report-types";

describe("REPORT_TYPES", () => {
  it("has 13 report types", () => {
    expect(REPORT_TYPES).toHaveLength(13);
  });

  it("matches the backend allowlist in api/py/_reports.py", () => {
    const ids = REPORT_TYPES.map((t) => t.id).sort();
    expect(ids).toEqual(
      [
        "light-rain", "heavy-rain", "thunderstorm", "hail", "flooding",
        "strong-wind", "clear-skies", "cloudy", "fog", "mist", "haze",
        "dust", "frost",
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

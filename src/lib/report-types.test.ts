/**
 * Tests for report-types.ts — the shared id/label/icon source for community
 * weather reports, consumed by both WeatherReportModal and RecentReports so
 * the two surfaces of this feature can't silently drift from each other.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Flame } from "lucide-react";
import {
  EMERGENCY_NOTICE,
  REPORT_TYPES,
  UNVERIFIED_REPORT_LABEL,
  getReportTypeInfo,
  showsVerified,
  unverifiedLabel,
} from "./report-types";

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

/** The bridge's copy of the allowlist (`REPORT_TYPES` in validate.ts). */
function bridgeList(name: string): string[] {
  const source = readFileSync(
    resolve(__dirname, "../../workers/mongo-bridge/src/validate.ts"),
    "utf-8",
  );
  const block = new RegExp(
    `export const ${name} = \\[([^\\]]*)\\] as const;`,
  ).exec(source);
  if (!block) throw new Error(`${name} not found in validate.ts`);
  return [...block[1].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
}

/** `NEVER_VERIFIED` in `weather_core::community`: types no forecast confirms. */
function workerNeverVerified(): string[] {
  const source = readFileSync(
    resolve(__dirname, "../../workers/crates/weather-core/src/community.rs"),
    "utf-8",
  );
  const block =
    /pub const NEVER_VERIFIED: \[&str; (\d+)\] = \[([^\]]*)\];/.exec(source);
  if (!block) throw new Error("NEVER_VERIFIED not found in community.rs");
  const ids = [...block[2].matchAll(/"([a-z-]+)"/g)].map((m) => m[1]);
  expect(ids).toHaveLength(Number(block[1]));
  return ids;
}

describe("REPORT_TYPES", () => {
  it("has 14 report types", () => {
    expect(REPORT_TYPES).toHaveLength(14);
  });

  it("matches the MongoDB bridge's allowlist (workers/mongo-bridge/src/validate.ts)", () => {
    expect([...REPORT_TYPES.map((t) => t.id)].sort()).toEqual(
      [...bridgeList("REPORT_TYPES")].sort(),
    );
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
        "wildfire",
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

describe("wildfire", () => {
  const info = getReportTypeInfo("wildfire");

  it("is offered with its own label and the Lucide Flame icon", () => {
    expect(info?.label).toBe("Wildfire");
    expect(info?.icon).toBe(Flame);
  });

  it("sits beside flooding in the wizard grid", () => {
    const ids = REPORT_TYPES.map((t) => t.id);
    expect(ids.indexOf("wildfire")).toBe(ids.indexOf("flooding") + 1);
  });

  it("is a type no forecast can confirm, on the Worker, the bridge and here", () => {
    expect(workerNeverVerified()).toEqual(["wildfire"]);
    expect(bridgeList("NEVER_VERIFIED_REPORT_TYPES")).toEqual(["wildfire"]);
    expect(
      REPORT_TYPES.filter((t) => t.neverVerified).map((t) => t.id),
    ).toEqual(workerNeverVerified());
  });

  it("says it is not an emergency service before the report is sent", () => {
    expect(info?.notice).toBe(EMERGENCY_NOTICE);
    expect(EMERGENCY_NOTICE).toContain("not an emergency service");
    expect(EMERGENCY_NOTICE).toContain(
      "If anyone is in danger, call your local emergency services first.",
    );
    // The app is used in many countries: no number is ever invented.
    expect(EMERGENCY_NOTICE).not.toMatch(/\d/);
    expect(info?.sentNote).not.toMatch(/\d/);
  });

  it("is labelled a community report, unverified, and never verified", () => {
    expect(UNVERIFIED_REPORT_LABEL).toBe("Community report, unverified");
    expect(unverifiedLabel("wildfire")).toBe("Community report, unverified");
    expect(info?.sentNote).toContain(UNVERIFIED_REPORT_LABEL);
    // Even a stored flag that says verified never shows a verified mark.
    expect(showsVerified("wildfire", true)).toBe(false);
    expect(showsVerified("wildfire", false)).toBe(false);
  });

  it("changes nothing for the other types", () => {
    expect(unverifiedLabel("flooding")).toBeNull();
    expect(unverifiedLabel("unknown-type")).toBeNull();
    expect(showsVerified("heavy-rain", true)).toBe(true);
    expect(showsVerified("heavy-rain", false)).toBe(false);
    expect(showsVerified("flooding", true)).toBe(true);
    expect(showsVerified("unknown-type", true)).toBe(true);
    for (const t of REPORT_TYPES.filter((t) => t.id !== "wildfire")) {
      expect(t.neverVerified).toBeUndefined();
      expect(t.notice).toBeUndefined();
    }
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

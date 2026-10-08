import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "CommunityLane.tsx"), "utf-8");
const skeleton = readFileSync(
  resolve(__dirname, "CommunityLaneSkeleton.tsx"),
  "utf-8",
);

/**
 * CommunityLane — the signature 24-hour lane per selected activity, with
 * community reports pinned along it. Structure tests only (no DOM in the
 * node test env); the pure logic is covered in src/lib/community-lane.test.ts.
 */

describe("CommunityLane structure", () => {
  it("is a client component and exports CommunityLane with its props", () => {
    expect(source).toContain('"use client"');
    expect(source).toContain("export function CommunityLane(");
    expect(source).toContain("export interface CommunityLaneProps");
    for (const prop of [
      "slug",
      "lat",
      "lon",
      "weather",
      "selectedActivities",
    ]) {
      expect(source).toContain(`${prop}`);
    }
  });

  it("caps lanes at LANE_MAX_ACTIVITIES", () => {
    expect(source).toContain("LANE_MAX_ACTIVITIES");
    expect(source).toContain(".slice(0, LANE_MAX_ACTIVITIES)");
  });

  it("opens My Weather on the activities tab when nothing is picked", () => {
    expect(source).toContain('openMyWeather("activities")');
    expect(source).toContain("Pick activities");
  });

  it("loads rules through the shared suitability cache and reports from the API", () => {
    expect(source).toContain("fetchSuitabilityRules");
    expect(source).toContain("/api/py/reports?location=");
    expect(source).toContain("hours=24");
  });

  it("uses the shared report-type labels and icons", () => {
    expect(source).toContain("getReportTypeInfo");
  });
});

describe("CommunityLane accessibility", () => {
  it("labels the section and each lane, and describes each lane in text", () => {
    expect(source).toContain("aria-labelledby={headingId}");
    expect(source).toContain('role="group"');
    expect(source).toContain("aria-describedby={summaryId}");
    expect(source).toContain("laneSummary(");
  });

  it("makes pins keyboard-focusable disclosure buttons", () => {
    expect(source).toContain("aria-expanded={expanded}");
    expect(source).toContain("aria-controls={panelId}");
    expect(source).toContain('role="region"');
  });

  it("sizes every tap target to the touch token", () => {
    expect(source).toContain("min-h-[var(--touch-target-min)]");
    expect(source).toContain("min-w-[var(--touch-target-min)]");
  });

  it("hides decorative grid cells from assistive tech", () => {
    expect(source).toContain('aria-hidden="true"');
  });
});

describe("CommunityLane visual rules", () => {
  it("never uses inline styles or raw colour values", () => {
    expect(source).not.toMatch(/style=\{\{/);
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(/);
  });

  it("carries the rating in bar height as well as colour", () => {
    expect(source).toContain("LEVEL_HEIGHT");
    expect(source).toContain('excellent: "h-full"');
    expect(source).toContain('poor: "h-1/4"');
  });

  it("takes each lane's mineral from its category, never a dynamic class", () => {
    expect(source).toContain("CATEGORY_STYLES");
    expect(source).toContain("borderAccent");
    for (const mineral of [
      "malachite",
      "terracotta",
      "cobalt",
      "tanzanite",
      "gold",
      "copper",
    ]) {
      expect(source).toContain(`bg-mineral-${mineral}`);
    }
  });
});

describe("CommunityLaneSkeleton", () => {
  it("announces itself as a loading status", () => {
    expect(skeleton).toContain('role="status"');
    expect(skeleton).toContain('aria-label="Loading"');
  });

  it("exports the skeleton component", () => {
    expect(skeleton).toContain("export function CommunityLaneSkeleton");
  });
});

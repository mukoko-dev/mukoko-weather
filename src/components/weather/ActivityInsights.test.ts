import { describe, it, expect } from "vitest";
import {
  heatStressLevel,
  precipTypeName,
  uvConcernLabel,
  moonPhaseName,
  evaluateSuitability,
} from "./ActivityInsights";
import type { SuitabilityRuleDoc } from "@/lib/db";
import type { WeatherInsights } from "@/lib/weather";
import type { Activity } from "@/lib/activities";

// ── heatStressLevel ──────────────────────────────────────────────────────────

describe("heatStressLevel", () => {
  it("returns 'None' for index below 22", () => {
    expect(heatStressLevel(0).label).toBe("None");
    expect(heatStressLevel(15).label).toBe("None");
    expect(heatStressLevel(21).label).toBe("None");
  });

  it("returns 'Mild' for index 22-23", () => {
    expect(heatStressLevel(22).label).toBe("Mild");
    expect(heatStressLevel(23).label).toBe("Mild");
  });

  it("returns 'Moderate' for index 24-25", () => {
    expect(heatStressLevel(24).label).toBe("Moderate");
    expect(heatStressLevel(25).label).toBe("Moderate");
  });

  it("returns 'Medium' for index 26-27", () => {
    expect(heatStressLevel(26).label).toBe("Medium");
    expect(heatStressLevel(27).label).toBe("Medium");
  });

  it("returns 'Severe' for index 28-29", () => {
    expect(heatStressLevel(28).label).toBe("Severe");
    expect(heatStressLevel(29).label).toBe("Severe");
  });

  it("returns 'Extreme' for index 30+", () => {
    expect(heatStressLevel(30).label).toBe("Extreme");
    expect(heatStressLevel(40).label).toBe("Extreme");
  });

  it("uses brand severity CSS classes, not hardcoded colors", () => {
    const levels = [0, 22, 24, 26, 28, 30];
    for (const index of levels) {
      const { className } = heatStressLevel(index);
      expect(className).toMatch(/^text-severity-/);
    }
  });

  it("escalates severity progressively", () => {
    const severityOrder = ["low", "moderate", "high", "high", "severe", "extreme"];
    const indices = [0, 22, 24, 26, 28, 30];
    for (let i = 0; i < indices.length; i++) {
      expect(heatStressLevel(indices[i]).className).toBe(`text-severity-${severityOrder[i]}`);
    }
  });
});

// ── precipTypeName ───────────────────────────────────────────────────────────

describe("precipTypeName", () => {
  it("returns 'None' for type 0", () => {
    expect(precipTypeName(0)).toBe("None");
  });

  it("returns 'Rain' for type 1", () => {
    expect(precipTypeName(1)).toBe("Rain");
  });

  it("returns 'Snow' for type 2", () => {
    expect(precipTypeName(2)).toBe("Snow");
  });

  it("returns 'Freezing Rain' for type 3", () => {
    expect(precipTypeName(3)).toBe("Freezing Rain");
  });

  it("returns 'Ice Pellets' for type 4", () => {
    expect(precipTypeName(4)).toBe("Ice Pellets");
  });

  it("returns 'Unknown' for unrecognized types", () => {
    expect(precipTypeName(5)).toBe("Unknown");
    expect(precipTypeName(-1)).toBe("Unknown");
    expect(precipTypeName(99)).toBe("Unknown");
  });
});

// ── uvConcernLabel ───────────────────────────────────────────────────────────

describe("uvConcernLabel", () => {
  it("returns 'Low' for concern 0-2", () => {
    expect(uvConcernLabel(0).label).toBe("Low");
    expect(uvConcernLabel(1).label).toBe("Low");
    expect(uvConcernLabel(2).label).toBe("Low");
  });

  it("returns 'Moderate' for concern 3-5", () => {
    expect(uvConcernLabel(3).label).toBe("Moderate");
    expect(uvConcernLabel(4).label).toBe("Moderate");
    expect(uvConcernLabel(5).label).toBe("Moderate");
  });

  it("returns 'High' for concern 6-7", () => {
    expect(uvConcernLabel(6).label).toBe("High");
    expect(uvConcernLabel(7).label).toBe("High");
  });

  it("returns 'Very High' for concern 8-10", () => {
    expect(uvConcernLabel(8).label).toBe("Very High");
    expect(uvConcernLabel(10).label).toBe("Very High");
  });

  it("returns 'Extreme' for concern above 10", () => {
    expect(uvConcernLabel(11).label).toBe("Extreme");
    expect(uvConcernLabel(15).label).toBe("Extreme");
  });

  it("uses brand severity CSS classes, not hardcoded colors", () => {
    const levels = [0, 3, 6, 8, 11];
    for (const concern of levels) {
      const { className } = uvConcernLabel(concern);
      expect(className).toMatch(/^text-severity-/);
    }
  });
});

// ── moonPhaseName ────────────────────────────────────────────────────────────

describe("moonPhaseName", () => {
  it("returns correct phase names for indices 0-7", () => {
    const expected = [
      "New Moon", "Waxing Crescent", "First Quarter", "Waxing Gibbous",
      "Full Moon", "Waning Gibbous", "Third Quarter", "Waning Crescent",
    ];
    for (let i = 0; i < expected.length; i++) {
      expect(moonPhaseName(i)).toBe(expected[i]);
    }
  });

  it("returns 'Unknown' for out-of-range indices", () => {
    expect(moonPhaseName(8)).toBe("Unknown");
    expect(moonPhaseName(-1)).toBe("Unknown");
    expect(moonPhaseName(99)).toBe("Unknown");
  });
});

// ── evaluateSuitability ──────────────────────────────────────────────────────

describe("evaluateSuitability", () => {
  const fakeActivity: Activity = {
    id: "crop-farming",
    label: "Crop Farming",
    category: "farming",
    relevantTags: ["farming"],
    icon: "wheat",
    description: "Test",
  };

  const fakeInsights = { temperatureMax: 35, humidity: 80 } as unknown as WeatherInsights;

  const activityRule: SuitabilityRuleDoc = {
    key: "activity:crop-farming",
    conditions: [
      { field: "temperatureMax", operator: "gt", value: 40, level: "poor", label: "Too Hot", colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10", detail: "Extreme heat" },
    ],
    fallback: { level: "good", label: "Good", colorClass: "text-severity-low", bgClass: "bg-severity-low/10", detail: "Conditions OK" },
    updatedAt: new Date(),
  };

  const categoryRule: SuitabilityRuleDoc = {
    key: "category:farming",
    conditions: [
      { field: "humidity", operator: "gte", value: 90, level: "poor", label: "Very Humid", colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10", detail: "Oppressive humidity" },
    ],
    fallback: { level: "good", label: "OK", colorClass: "text-severity-low", bgClass: "bg-severity-low/10", detail: "Farming conditions acceptable" },
    updatedAt: new Date(),
  };

  it("prefers activity-specific rule when present", () => {
    const rules = new Map<string, SuitabilityRuleDoc>([
      ["activity:crop-farming", activityRule],
      ["category:farming", categoryRule],
    ]);
    const result = evaluateSuitability(fakeActivity, fakeInsights, rules);
    // activityRule fallback ("Good") should be returned since temp 35 < 40
    expect(result.label).toBe("Good");
    expect(result.detail).toBe("Conditions OK");
  });

  it("falls back to category rule when no activity rule exists", () => {
    const rules = new Map<string, SuitabilityRuleDoc>([
      ["category:farming", categoryRule],
    ]);
    const result = evaluateSuitability(fakeActivity, fakeInsights, rules);
    // categoryRule fallback ("OK") since humidity 80 < 90
    expect(result.label).toBe("OK");
    expect(result.detail).toBe("Farming conditions acceptable");
  });

  it("returns generic fallback when no rules exist at all", () => {
    const rules = new Map<string, SuitabilityRuleDoc>();
    const result = evaluateSuitability(fakeActivity, fakeInsights, rules);
    expect(result.level).toBe("fair");
    expect(result.detail).toBe("No specific rules available for this activity");
  });

  it("matches a condition when threshold is met", () => {
    const hotInsights = { temperatureMax: 45 } as unknown as WeatherInsights;
    const rules = new Map<string, SuitabilityRuleDoc>([
      ["activity:crop-farming", activityRule],
    ]);
    const result = evaluateSuitability(fakeActivity, hotInsights, rules);
    expect(result.level).toBe("poor");
    expect(result.label).toBe("Too Hot");
  });
});

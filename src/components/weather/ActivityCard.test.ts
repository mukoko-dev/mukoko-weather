import { describe, it, expect } from "vitest";
import { evaluateSuitability } from "./ActivityInsights";
import type { Activity } from "@/lib/activities";
import type { WeatherInsights } from "@/lib/weather";
import type { SuitabilityRuleDoc } from "@/lib/db";

// ---------------------------------------------------------------------------
// ActivityCard depends on evaluateSuitability for its rating. These tests
// cover the full card-rendering logic path: activity + insights → rating.
// ---------------------------------------------------------------------------

const makeActivity = (overrides: Partial<Activity> = {}): Activity => ({
  id: "crop-farming",
  label: "Crop Farming",
  category: "farming",
  relevantTags: ["farming"],
  icon: "wheat",
  description: "Test activity",
  ...overrides,
});

const makeInsights = (fields: Record<string, number>): WeatherInsights =>
  fields as unknown as WeatherInsights;

// ── evaluateSuitability (used by ActivityCard) ─────────────────────────────

describe("ActivityCard — evaluateSuitability integration", () => {
  const poorRule: SuitabilityRuleDoc = {
    key: "category:farming",
    conditions: [
      {
        field: "thunderstormProbability",
        operator: "gt",
        value: 50,
        level: "poor",
        label: "Poor",
        colorClass: "text-severity-severe",
        bgClass: "bg-severity-severe/10",
        detail: "High thunderstorm risk",
        metricTemplate: "Storm: {value}%",
      },
      {
        field: "heatStressIndex",
        operator: "gte",
        value: 28,
        level: "poor",
        label: "Unsafe",
        colorClass: "text-severity-severe",
        bgClass: "bg-severity-severe/10",
        detail: "Dangerous heat stress",
        metricTemplate: "Heat: {value}",
      },
    ],
    fallback: {
      level: "good",
      label: "Good",
      colorClass: "text-severity-low",
      bgClass: "bg-severity-low/10",
      detail: "Favorable conditions",
    },
    updatedAt: new Date(),
  };

  const excellentRule: SuitabilityRuleDoc = {
    key: "activity:crop-farming",
    conditions: [
      {
        field: "gdd10To30",
        operator: "gte",
        value: 15,
        level: "excellent",
        label: "Excellent",
        colorClass: "text-severity-low",
        bgClass: "bg-severity-low/10",
        detail: "Ideal growing conditions",
        metricTemplate: "GDD: {value}",
      },
    ],
    fallback: {
      level: "good",
      label: "Good",
      colorClass: "text-severity-low",
      bgClass: "bg-severity-low/10",
      detail: "Normal conditions",
    },
    updatedAt: new Date(),
  };

  it("returns 'poor' rating when thunderstorm probability is high", () => {
    const rules = new Map([["category:farming", poorRule]]);
    const result = evaluateSuitability(
      makeActivity(),
      makeInsights({ thunderstormProbability: 80 }),
      rules,
    );
    expect(result.level).toBe("poor");
    expect(result.label).toBe("Poor");
    expect(result.detail).toBe("High thunderstorm risk");
    expect(result.metric).toBe("Storm: 80%");
  });

  it("returns 'poor' for heat stress when thunderstorm is not triggered", () => {
    const rules = new Map([["category:farming", poorRule]]);
    const result = evaluateSuitability(
      makeActivity(),
      makeInsights({ thunderstormProbability: 20, heatStressIndex: 30 }),
      rules,
    );
    expect(result.level).toBe("poor");
    expect(result.label).toBe("Unsafe");
    expect(result.metric).toBe("Heat: 30");
  });

  it("returns fallback 'good' when no conditions match", () => {
    const rules = new Map([["category:farming", poorRule]]);
    const result = evaluateSuitability(
      makeActivity(),
      makeInsights({ thunderstormProbability: 10, heatStressIndex: 20 }),
      rules,
    );
    expect(result.level).toBe("good");
    expect(result.label).toBe("Good");
    expect(result.detail).toBe("Favorable conditions");
  });

  it("returns 'excellent' when activity-specific condition matches", () => {
    const rules = new Map<string, SuitabilityRuleDoc>([
      ["activity:crop-farming", excellentRule],
      ["category:farming", poorRule],
    ]);
    const result = evaluateSuitability(
      makeActivity(),
      makeInsights({ gdd10To30: 20 }),
      rules,
    );
    expect(result.level).toBe("excellent");
    expect(result.label).toBe("Excellent");
    expect(result.metric).toBe("GDD: 20");
  });

  it("prefers activity-specific rule over category rule", () => {
    const rules = new Map<string, SuitabilityRuleDoc>([
      ["activity:crop-farming", excellentRule],
      ["category:farming", poorRule],
    ]);
    // gdd10To30 not high enough → activity fallback "Good"
    const result = evaluateSuitability(
      makeActivity(),
      makeInsights({ gdd10To30: 5, thunderstormProbability: 80 }),
      rules,
    );
    // Activity rule fallback is used, NOT the category poor condition
    expect(result.level).toBe("good");
    expect(result.label).toBe("Good");
    expect(result.detail).toBe("Normal conditions");
  });

  it("falls through to category rule when no activity rule exists", () => {
    const rules = new Map([["category:farming", poorRule]]);
    const result = evaluateSuitability(
      makeActivity({ id: "livestock", category: "farming" }),
      makeInsights({ thunderstormProbability: 80 }),
      rules,
    );
    expect(result.level).toBe("poor");
    expect(result.label).toBe("Poor");
  });

  it("returns generic fallback for unknown categories with no rules", () => {
    const result = evaluateSuitability(
      makeActivity({ id: "unknown-thing", category: "unknown" as never }),
      makeInsights({ thunderstormProbability: 90 }),
      new Map(),
    );
    expect(result.level).toBe("fair");
    expect(result.detail).toBe("No specific rules available for this activity");
  });

  it("skips conditions with missing insight fields", () => {
    const rules = new Map([["category:farming", poorRule]]);
    // No thunderstormProbability or heatStressIndex in insights
    const result = evaluateSuitability(
      makeActivity(),
      makeInsights({}),
      rules,
    );
    // All conditions skip → fallback
    expect(result.level).toBe("good");
  });

  it("rating colorClass and bgClass use severity tokens", () => {
    const rules = new Map([["category:farming", poorRule]]);
    const result = evaluateSuitability(
      makeActivity(),
      makeInsights({ thunderstormProbability: 80 }),
      rules,
    );
    expect(result.colorClass).toMatch(/^text-severity-/);
    expect(result.bgClass).toMatch(/^bg-severity-/);
  });

  it("first matching condition wins (order-dependent)", () => {
    const rules = new Map([["category:farming", poorRule]]);
    // Both conditions match — thunderstorm > 50 AND heat >= 28
    const result = evaluateSuitability(
      makeActivity(),
      makeInsights({ thunderstormProbability: 80, heatStressIndex: 30 }),
      rules,
    );
    // First condition (thunderstorm) should win
    expect(result.label).toBe("Poor");
    expect(result.detail).toBe("High thunderstorm risk");
  });
});

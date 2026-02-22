import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { evaluateRule, evaluateSuitability } from "./suitability";
import type { Activity } from "./activities";
import type { SuitabilityRuleDoc } from "./db";
import type { WeatherInsights } from "./weather";

const source = readFileSync(resolve(__dirname, "suitability.ts"), "utf-8");

const MOCK_RULE: SuitabilityRuleDoc = {
  key: "activity:drone-flying",
  conditions: [
    {
      field: "thunderstormProbability",
      operator: "gt",
      value: 20,
      level: "poor",
      label: "Grounded",
      colorClass: "text-severity-severe",
      bgClass: "bg-severity-severe/10",
      detail: "Storm risk — do not fly",
      metricTemplate: "Storm: {value}%",
    },
    {
      field: "visibility",
      operator: "lt",
      value: 1,
      level: "poor",
      label: "Grounded",
      colorClass: "text-severity-severe",
      bgClass: "bg-severity-severe/10",
      detail: "Visibility too low for safe flight",
      metricTemplate: "Vis: {value} km",
    },
    {
      field: "visibility",
      operator: "lt",
      value: 3,
      level: "fair",
      label: "Caution",
      colorClass: "text-severity-moderate",
      bgClass: "bg-severity-moderate/10",
      detail: "Reduced visibility — fly with caution",
      metricTemplate: "Vis: {value} km",
    },
  ],
  fallback: {
    level: "excellent",
    label: "Flyable",
    colorClass: "text-severity-low",
    bgClass: "bg-severity-low/10",
    detail: "Clear skies — ideal drone conditions",
  },
  updatedAt: new Date(),
};

describe("evaluateRule", () => {
  it("returns first matching condition (thunderstorm)", () => {
    const result = evaluateRule(MOCK_RULE, { thunderstormProbability: 50 });
    expect(result.level).toBe("poor");
    expect(result.label).toBe("Grounded");
    expect(result.metric).toBe("Storm: 50%");
  });

  it("returns second matching condition (very low visibility)", () => {
    const result = evaluateRule(MOCK_RULE, { visibility: 0.5 });
    expect(result.level).toBe("poor");
    expect(result.label).toBe("Grounded");
    expect(result.metric).toBe("Vis: 0.5 km");
  });

  it("returns third matching condition (reduced visibility)", () => {
    const result = evaluateRule(MOCK_RULE, { visibility: 2 });
    expect(result.level).toBe("fair");
    expect(result.label).toBe("Caution");
    expect(result.metric).toBe("Vis: 2.0 km");
  });

  it("returns fallback when no condition matches", () => {
    const result = evaluateRule(MOCK_RULE, { visibility: 10 });
    expect(result.level).toBe("excellent");
    expect(result.label).toBe("Flyable");
    expect(result.metric).toBeUndefined();
  });

  it("returns fallback for empty insights", () => {
    const result = evaluateRule(MOCK_RULE, {});
    expect(result.level).toBe("excellent");
    expect(result.label).toBe("Flyable");
    expect(result.metric).toBeUndefined();
  });

  it("skips conditions where the field is not present in insights", () => {
    const result = evaluateRule(MOCK_RULE, { uvHealthConcern: 5 });
    expect(result.level).toBe("excellent");
    expect(result.label).toBe("Flyable");
  });

  it("uses severity CSS classes", () => {
    const result = evaluateRule(MOCK_RULE, { thunderstormProbability: 50 });
    expect(result.colorClass).toMatch(/^text-severity-/);
    expect(result.bgClass).toMatch(/^bg-severity-/);
  });

  it("first condition wins when multiple match", () => {
    const result = evaluateRule(MOCK_RULE, {
      thunderstormProbability: 50,
      visibility: 0.5,
    });
    // thunderstorm condition is first, so it should win
    expect(result.label).toBe("Grounded");
    expect(result.detail).toContain("Storm risk");
  });
});

describe("evaluateRule with operators", () => {
  const makeRule = (operator: "gt" | "gte" | "lt" | "lte" | "eq", value: number): SuitabilityRuleDoc => ({
    key: "test",
    conditions: [{
      field: "thunderstormProbability",
      operator,
      value,
      level: "poor",
      label: "Match",
      colorClass: "text-severity-severe",
      bgClass: "bg-severity-severe/10",
      detail: "Matched",
    }],
    fallback: { level: "good", label: "No Match", colorClass: "text-severity-low", bgClass: "bg-severity-low/10", detail: "No match" },
    updatedAt: new Date(),
  });

  it("gt: matches when value is greater", () => {
    expect(evaluateRule(makeRule("gt", 50), { thunderstormProbability: 51 }).label).toBe("Match");
    expect(evaluateRule(makeRule("gt", 50), { thunderstormProbability: 50 }).label).toBe("No Match");
  });

  it("gte: matches when value is greater or equal", () => {
    expect(evaluateRule(makeRule("gte", 50), { thunderstormProbability: 50 }).label).toBe("Match");
    expect(evaluateRule(makeRule("gte", 50), { thunderstormProbability: 49 }).label).toBe("No Match");
  });

  it("lt: matches when value is less", () => {
    expect(evaluateRule(makeRule("lt", 50), { thunderstormProbability: 49 }).label).toBe("Match");
    expect(evaluateRule(makeRule("lt", 50), { thunderstormProbability: 50 }).label).toBe("No Match");
  });

  it("lte: matches when value is less or equal", () => {
    expect(evaluateRule(makeRule("lte", 50), { thunderstormProbability: 50 }).label).toBe("Match");
    expect(evaluateRule(makeRule("lte", 50), { thunderstormProbability: 51 }).label).toBe("No Match");
  });

  it("eq: matches exact value", () => {
    expect(evaluateRule(makeRule("eq", 50), { thunderstormProbability: 50 }).label).toBe("Match");
    expect(evaluateRule(makeRule("eq", 50), { thunderstormProbability: 51 }).label).toBe("No Match");
  });
});

describe("evaluateRule with wind speed conditions", () => {
  const WIND_RULE: SuitabilityRuleDoc = {
    key: "activity:drone-flying",
    conditions: [
      {
        field: "windGust", operator: "gt", value: 40,
        level: "poor", label: "Grounded",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Dangerous gusts", metricTemplate: "Gust: {value} km/h",
      },
      {
        field: "windSpeed", operator: "gt", value: 35,
        level: "poor", label: "Grounded",
        colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
        detail: "Wind too strong", metricTemplate: "Wind: {value} km/h",
      },
      {
        field: "windSpeed", operator: "gt", value: 20,
        level: "fair", label: "Caution",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "Moderate wind", metricTemplate: "Wind: {value} km/h",
      },
    ],
    fallback: {
      level: "excellent", label: "Flyable",
      colorClass: "text-severity-low", bgClass: "bg-severity-low/10",
      detail: "Calm winds",
    },
    updatedAt: new Date(),
  };

  it("grounds drone on dangerous gusts (>40 km/h)", () => {
    const result = evaluateRule(WIND_RULE, { windGust: 45 });
    expect(result.level).toBe("poor");
    expect(result.label).toBe("Grounded");
    expect(result.metric).toBe("Gust: 45 km/h");
  });

  it("grounds drone on high sustained wind (>35 km/h)", () => {
    const result = evaluateRule(WIND_RULE, { windSpeed: 38 });
    expect(result.level).toBe("poor");
    expect(result.label).toBe("Grounded");
    expect(result.metric).toBe("Wind: 38 km/h");
  });

  it("shows caution on moderate wind (>20 km/h)", () => {
    const result = evaluateRule(WIND_RULE, { windSpeed: 25 });
    expect(result.level).toBe("fair");
    expect(result.label).toBe("Caution");
  });

  it("returns flyable in calm winds", () => {
    const result = evaluateRule(WIND_RULE, { windSpeed: 10, windGust: 15 });
    expect(result.level).toBe("excellent");
    expect(result.label).toBe("Flyable");
    expect(result.metric).toBeUndefined();
  });
});

describe("code quality", () => {
  it("documents eq operator limitation for float values", () => {
    expect(source).toContain("safe for integer-valued alert levels");
    expect(source).toContain("Not suitable for continuous float measurements");
  });

  it("uses DECIMAL_FIELDS set instead of inline field-name checks", () => {
    expect(source).toContain('const DECIMAL_FIELDS = new Set(["visibility", "evapotranspiration"])');
    expect(source).toContain("DECIMAL_FIELDS.has(");
  });

  it("resolves visibility with one decimal place via DECIMAL_FIELDS", () => {
    const visRule: SuitabilityRuleDoc = {
      key: "test-vis",
      conditions: [{
        field: "visibility", operator: "lt", value: 5,
        level: "fair", label: "Low Vis",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "Low visibility", metricTemplate: "Vis: {value} km",
      }],
      fallback: { level: "good", label: "OK", colorClass: "c", bgClass: "b", detail: "Good" },
      updatedAt: new Date(),
    };
    const result = evaluateRule(visRule, { visibility: 2.7 });
    expect(result.metric).toBe("Vis: 2.7 km");
  });

  it("resolves evapotranspiration with one decimal place via DECIMAL_FIELDS", () => {
    const etRule: SuitabilityRuleDoc = {
      key: "test-et",
      conditions: [{
        field: "evapotranspiration", operator: "gt", value: 3,
        level: "fair", label: "High ET",
        colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
        detail: "High ET", metricTemplate: "ET: {evapotranspiration} mm",
      }],
      fallback: { level: "good", label: "OK", colorClass: "c", bgClass: "b", detail: "Normal" },
      updatedAt: new Date(),
    };
    const result = evaluateRule(etRule, { evapotranspiration: 4.56 });
    expect(result.metric).toBe("ET: 4.6 mm");
  });
});

// ── evaluateSuitability (activity-level resolution) ─────────────────────────

describe("evaluateSuitability", () => {
  const fakeActivity: Activity = {
    id: "crop-farming",
    label: "Crop Farming",
    category: "farming",
    relevantTags: ["farming"],
    icon: "wheat",
    description: "Test",
  };

  const activityRule: SuitabilityRuleDoc = {
    key: "activity:crop-farming",
    conditions: [{
      field: "dewPoint", operator: "gt", value: 20,
      level: "fair", label: "Humid",
      colorClass: "text-severity-moderate", bgClass: "bg-severity-moderate/10",
      detail: "High dew point",
    }],
    fallback: { level: "good", label: "Good", colorClass: "text-severity-low", bgClass: "bg-severity-low/10", detail: "OK" },
    updatedAt: new Date(),
  };

  const categoryRule: SuitabilityRuleDoc = {
    key: "category:farming",
    conditions: [{
      field: "thunderstormProbability", operator: "gt", value: 50,
      level: "poor", label: "Stormy",
      colorClass: "text-severity-severe", bgClass: "bg-severity-severe/10",
      detail: "Storm risk",
    }],
    fallback: { level: "good", label: "OK", colorClass: "text-severity-low", bgClass: "bg-severity-low/10", detail: "Fine" },
    updatedAt: new Date(),
  };

  it("prefers activity-specific rule over category rule", () => {
    const rules = new Map<string, SuitabilityRuleDoc>([
      ["activity:crop-farming", activityRule],
      ["category:farming", categoryRule],
    ]);
    const result = evaluateSuitability(fakeActivity, { dewPoint: 25 } as WeatherInsights, rules);
    expect(result.label).toBe("Humid");
  });

  it("falls back to category rule when no activity rule", () => {
    const rules = new Map<string, SuitabilityRuleDoc>([
      ["category:farming", categoryRule],
    ]);
    const result = evaluateSuitability(fakeActivity, { thunderstormProbability: 60 } as WeatherInsights, rules);
    expect(result.label).toBe("Stormy");
  });

  it("returns generic fallback when no rules exist", () => {
    const result = evaluateSuitability(fakeActivity, {} as WeatherInsights, new Map());
    expect(result.level).toBe("fair");
    expect(result.detail).toBe("No specific rules available for this activity");
  });
});

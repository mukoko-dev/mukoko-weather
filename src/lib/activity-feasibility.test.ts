import { describe, it, expect } from "vitest";
import {
  LEVEL_SCORES,
  scoreLabel,
  dewPointFromTempHumidity,
  hourInsights,
  resolveRule,
  feasibilitySeries,
} from "./activity-feasibility";
import type { HourlyWeather } from "./weather";
import type { SuitabilityRuleDoc } from "./db";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 48 hours of hourly data starting at midnight today (local). */
function makeHourly(overrides: Partial<Record<keyof HourlyWeather, number[]>> = {}): HourlyWeather {
  const n = 48;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const time = Array.from({ length: n }, (_, i) =>
    new Date(start.getTime() + i * 3600_000).toISOString(),
  );
  const fill = (v: number) => Array.from({ length: n }, () => v);
  return {
    time,
    temperature_2m: fill(25),
    apparent_temperature: fill(25),
    relative_humidity_2m: fill(50),
    precipitation_probability: fill(0),
    precipitation: fill(0),
    weather_code: fill(0),
    visibility: fill(20000),
    cloud_cover: fill(10),
    surface_pressure: fill(1015),
    wind_speed_10m: fill(10),
    wind_direction_10m: fill(90),
    wind_gusts_10m: fill(15),
    uv_index: fill(5),
    is_day: fill(1),
    ...overrides,
  } as HourlyWeather;
}

const windRule: SuitabilityRuleDoc = {
  updatedAt: new Date(),
  key: "category:farming",
  conditions: [
    {
      field: "windSpeed",
      operator: "gt",
      value: 30,
      level: "poor",
      label: "Poor",
      colorClass: "text-severity-severe",
      bgClass: "bg-severity-severe/10",
      detail: "Too windy",
    },
  ],
  fallback: {
    level: "good",
    label: "Good",
    colorClass: "text-severity-low",
    bgClass: "bg-severity-low/10",
    detail: "Favorable",
  },
};

const activity = { id: "crop-farming", category: "farming" as const };

// ---------------------------------------------------------------------------
// LEVEL_SCORES / scoreLabel
// ---------------------------------------------------------------------------

describe("LEVEL_SCORES", () => {
  it("maps all four levels to distinct, ordered scores", () => {
    expect(LEVEL_SCORES.excellent).toBeGreaterThan(LEVEL_SCORES.good);
    expect(LEVEL_SCORES.good).toBeGreaterThan(LEVEL_SCORES.fair);
    expect(LEVEL_SCORES.fair).toBeGreaterThan(LEVEL_SCORES.poor);
    expect(LEVEL_SCORES.poor).toBeGreaterThan(0); // stays visible on the chart
  });

  it("scoreLabel round-trips each level score", () => {
    expect(scoreLabel(LEVEL_SCORES.excellent)).toBe("Excellent");
    expect(scoreLabel(LEVEL_SCORES.good)).toBe("Good");
    expect(scoreLabel(LEVEL_SCORES.fair)).toBe("Fair");
    expect(scoreLabel(LEVEL_SCORES.poor)).toBe("Poor");
  });
});

// ---------------------------------------------------------------------------
// Dew point (Magnus)
// ---------------------------------------------------------------------------

describe("dewPointFromTempHumidity", () => {
  it("equals air temperature at 100% humidity", () => {
    expect(dewPointFromTempHumidity(20, 100)).toBeCloseTo(20, 1);
  });

  it("gives the textbook ~9.3°C for 20°C at 50% RH", () => {
    expect(dewPointFromTempHumidity(20, 50)).toBeCloseTo(9.3, 0);
  });

  it("is lower for drier air", () => {
    expect(dewPointFromTempHumidity(30, 30)).toBeLessThan(dewPointFromTempHumidity(30, 80));
  });

  it("clamps nonsense humidity instead of returning NaN", () => {
    expect(Number.isFinite(dewPointFromTempHumidity(25, 0))).toBe(true);
    expect(Number.isFinite(dewPointFromTempHumidity(25, 150))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hourInsights — per-hour synthesis matches synthesizeOpenMeteoInsights rules
// ---------------------------------------------------------------------------

describe("hourInsights", () => {
  it("maps wind, visibility, uv and dew point from the hour's values", () => {
    const hourly = makeHourly({ wind_speed_10m: Array(48).fill(22), wind_gusts_10m: Array(48).fill(33) });
    const ins = hourInsights(hourly, 5);
    expect(ins.windSpeed).toBe(22);
    expect(ins.windGust).toBe(33);
    expect(ins.visibility).toBe(20000);
    expect(ins.uvHealthConcern).toBe(5);
    expect(ins.dewPoint).toBeCloseTo(dewPointFromTempHumidity(25, 50), 5);
  });

  it("derives thunderstorm probability from WMO 95+ codes", () => {
    const codes = Array(48).fill(0);
    codes[3] = 95;
    codes[4] = 96;
    codes[5] = 99;
    const hourly = makeHourly({ weather_code: codes });
    expect(hourInsights(hourly, 0).thunderstormProbability).toBe(0);
    expect(hourInsights(hourly, 3).thunderstormProbability).toBe(70);
    expect(hourInsights(hourly, 4).thunderstormProbability).toBe(85);
    expect(hourInsights(hourly, 5).thunderstormProbability).toBe(95);
  });

  it("derives precipitationType from WMO codes (rain/snow/freezing)", () => {
    const codes = Array(48).fill(0);
    codes[1] = 61; // rain
    codes[2] = 71; // snow
    codes[3] = 66; // freezing rain
    const hourly = makeHourly({ weather_code: codes });
    expect(hourInsights(hourly, 0).precipitationType).toBe(0);
    expect(hourInsights(hourly, 1).precipitationType).toBe(1);
    expect(hourInsights(hourly, 2).precipitationType).toBe(2);
    expect(hourInsights(hourly, 3).precipitationType).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// resolveRule / feasibilitySeries
// ---------------------------------------------------------------------------

describe("resolveRule", () => {
  it("prefers an activity-specific rule over the category rule", () => {
    const specific = { ...windRule, key: "activity:crop-farming" };
    const rules = new Map<string, SuitabilityRuleDoc>([
      ["category:farming", windRule],
      ["activity:crop-farming", specific],
    ]);
    expect(resolveRule(activity, rules)).toBe(specific);
  });

  it("falls back to the category rule", () => {
    const rules = new Map([["category:farming", windRule]]);
    expect(resolveRule(activity, rules)).toBe(windRule);
  });
});

describe("feasibilitySeries", () => {
  it("returns [] when no rule matches or hourly data is missing", () => {
    expect(feasibilitySeries(activity, makeHourly(), new Map())).toEqual([]);
    expect(feasibilitySeries(activity, undefined, new Map([["category:farming", windRule]]))).toEqual([]);
  });

  it("scores each of the next 24 hours against the rule", () => {
    const rules = new Map([["category:farming", windRule]]);
    const points = feasibilitySeries(activity, makeHourly(), rules);
    expect(points).toHaveLength(24);
    // Calm wind everywhere → fallback level "good" at every point
    expect(points.every((p) => p.level === "good" && p.score === LEVEL_SCORES.good)).toBe(true);
  });

  it("drops the score where the rule's poor condition matches", () => {
    const wind = Array(48).fill(10);
    wind.fill(40, 0, 48); // all hours over the 30 km/h threshold
    const rules = new Map([["category:farming", windRule]]);
    const points = feasibilitySeries(activity, makeHourly({ wind_speed_10m: wind }), rules);
    expect(points.every((p) => p.level === "poor" && p.score === LEVEL_SCORES.poor)).toBe(true);
  });

  it("starts at the current hour, not midnight", () => {
    const rules = new Map([["category:farming", windRule]]);
    const points = feasibilitySeries(activity, makeHourly(), rules);
    const firstHour = new Date(points[0].time).getHours();
    expect(firstHour).toBe(new Date().getHours());
  });
});

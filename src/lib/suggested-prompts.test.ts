import { describe, it, expect, beforeEach } from "vitest";
import {
  generateSuggestedPrompts,
  resetRulesCache,
  type SuggestedPromptRule,
} from "./suggested-prompts";
import type { WeatherData, CurrentWeather } from "./weather";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeWeather(overrides: Partial<CurrentWeather> = {}): WeatherData {
  return {
    current: {
      temperature_2m: 25,
      relative_humidity_2m: 50,
      apparent_temperature: 24,
      precipitation: 0,
      weather_code: 0,
      cloud_cover: 20,
      wind_speed_10m: 10,
      wind_direction_10m: 180,
      wind_gusts_10m: 15,
      uv_index: 5,
      surface_pressure: 1013,
      is_day: 1,
      ...overrides,
    },
    hourly: {
      time: [],
      temperature_2m: [],
      apparent_temperature: [],
      relative_humidity_2m: [],
      precipitation_probability: [20],
      precipitation: [],
      weather_code: [],
      visibility: [],
      cloud_cover: [],
      surface_pressure: [],
      wind_speed_10m: [],
      wind_direction_10m: [],
      wind_gusts_10m: [],
      uv_index: [],
      is_day: [],
    },
    daily: {
      time: [],
      weather_code: [],
      temperature_2m_max: [],
      temperature_2m_min: [],
      apparent_temperature_max: [],
      apparent_temperature_min: [],
      sunrise: [],
      sunset: [],
      uv_index_max: [],
      precipitation_sum: [],
      precipitation_probability_max: [],
      wind_speed_10m_max: [],
      wind_gusts_10m_max: [],
    },
    current_units: {},
  };
}

const loc = { name: "Harare", slug: "harare" };

// Sample database rules matching the seed data
const sampleRules: SuggestedPromptRule[] = [
  {
    ruleId: "weather:storm",
    label: "Storm safety",
    queryTemplate: "Is it safe to be outdoors in {location} during this storm?",
    category: "weather",
    condition: { field: "weather_code", operator: "gte", value: 95, source: "weather" },
    active: true,
    order: 1,
  },
  {
    ruleId: "weather:frost",
    label: "Frost precautions",
    queryTemplate: "What frost precautions should I take in {location}?",
    category: "weather",
    condition: { field: "temperature_2m", operator: "lte", value: 3, source: "weather" },
    active: true,
    order: 2,
  },
  {
    ruleId: "weather:heat",
    label: "Heat safety",
    queryTemplate: "Is it safe to work outdoors in {location} at {temperature}°C?",
    category: "weather",
    condition: { field: "temperature_2m", operator: "gte", value: 35, source: "weather" },
    active: true,
    order: 3,
  },
  {
    ruleId: "weather:uv",
    label: "UV protection",
    queryTemplate: "What sun protection do I need with a UV index of {uvIndex}?",
    category: "weather",
    condition: { field: "uv_index", operator: "gte", value: 8, source: "weather" },
    active: true,
    order: 4,
  },
  {
    ruleId: "weather:rain_active",
    label: "Rain impact",
    queryTemplate: "Will the rain affect my plans in {location} today?",
    category: "weather",
    condition: { field: "precipitation", operator: "gt", value: 0, source: "weather" },
    active: true,
    order: 5,
  },
  {
    ruleId: "weather:rain_forecast",
    label: "Rain impact",
    queryTemplate: "Will the rain affect my plans in {location} today?",
    category: "weather",
    condition: { field: "precipitation_probability", operator: "gt", value: 50, source: "hourly" },
    active: true,
    order: 6,
  },
  {
    ruleId: "weather:humidity",
    label: "Crop spraying",
    queryTemplate: "Is it safe to spray crops in {location} with {humidity}% humidity?",
    category: "weather",
    condition: { field: "relative_humidity_2m", operator: "gt", value: 75, source: "weather" },
    active: true,
    order: 7,
  },
  {
    ruleId: "weather:wind",
    label: "Wind impact",
    queryTemplate: "How will {windSpeed} km/h wind affect outdoor activities?",
    category: "weather",
    condition: { field: "wind_speed_10m", operator: "gt", value: 30, source: "weather" },
    active: true,
    order: 8,
  },
  {
    ruleId: "activity:farming",
    label: "Farming advice",
    queryTemplate: "How does today's weather affect farming in {location}?",
    category: "activity",
    condition: { field: "activities", operator: "in", value: ["maize-farming", "tobacco-farming", "horticulture"], source: "activities" },
    active: true,
    order: 10,
  },
  {
    ruleId: "activity:drone",
    label: "Drone conditions",
    queryTemplate: "Can I fly my drone safely in {location} today?",
    category: "activity",
    condition: { field: "activities", operator: "in", value: ["drone-flying"], source: "activities" },
    active: true,
    order: 11,
  },
  {
    ruleId: "activity:exercise",
    label: "Best time to exercise",
    queryTemplate: "What's the best time to exercise outdoors in {location} today?",
    category: "activity",
    condition: { field: "activities", operator: "in", value: ["running", "cycling", "hiking"], source: "activities" },
    active: true,
    order: 12,
  },
  {
    ruleId: "generic:plan_day",
    label: "Plan my day",
    queryTemplate: "What should I plan for today in {location}?",
    category: "generic",
    condition: null,
    active: true,
    order: 100,
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateSuggestedPrompts", () => {
  beforeEach(() => {
    resetRulesCache();
  });

  it("returns max 3 prompts", () => {
    const weather = makeWeather({
      temperature_2m: 38,
      relative_humidity_2m: 85,
      wind_speed_10m: 40,
      uv_index: 10,
      weather_code: 95,
    });
    const result = generateSuggestedPrompts(weather, loc, ["running", "drone-flying", "maize-farming"], sampleRules);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("always includes at least one prompt (generic fallback)", () => {
    const weather = makeWeather();
    const result = generateSuggestedPrompts(weather, loc, [], sampleRules);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((p) => p.label === "Plan my day")).toBe(true);
  });

  it("includes storm safety prompt for severe weather codes", () => {
    const weather = makeWeather({ weather_code: 95 });
    const result = generateSuggestedPrompts(weather, loc, [], sampleRules);
    expect(result.some((p) => p.label === "Storm safety")).toBe(true);
  });

  it("includes frost prompt for very cold temperatures", () => {
    const weather = makeWeather({ temperature_2m: 2 });
    const result = generateSuggestedPrompts(weather, loc, [], sampleRules);
    expect(result.some((p) => p.label === "Frost precautions")).toBe(true);
  });

  it("includes heat prompt for extreme temperatures", () => {
    const weather = makeWeather({ temperature_2m: 38 });
    const result = generateSuggestedPrompts(weather, loc, [], sampleRules);
    expect(result.some((p) => p.label === "Heat safety")).toBe(true);
  });

  it("includes UV prompt for high UV index", () => {
    const weather = makeWeather({ uv_index: 9 });
    const result = generateSuggestedPrompts(weather, loc, [], sampleRules);
    expect(result.some((p) => p.label === "UV protection")).toBe(true);
  });

  it("includes rain prompt when precipitation is active", () => {
    const weather = makeWeather({ precipitation: 2.5 });
    const result = generateSuggestedPrompts(weather, loc, [], sampleRules);
    expect(result.some((p) => p.label === "Rain impact")).toBe(true);
  });

  it("includes humidity prompt for high humidity", () => {
    const weather = makeWeather({ relative_humidity_2m: 85 });
    const result = generateSuggestedPrompts(weather, loc, [], sampleRules);
    expect(result.some((p) => p.label === "Crop spraying")).toBe(true);
  });

  it("includes wind prompt for strong wind", () => {
    const weather = makeWeather({ wind_speed_10m: 35 });
    const result = generateSuggestedPrompts(weather, loc, [], sampleRules);
    expect(result.some((p) => p.label === "Wind impact")).toBe(true);
  });

  it("includes farming prompt when farming activities selected", () => {
    const weather = makeWeather();
    const result = generateSuggestedPrompts(weather, loc, ["maize-farming"], sampleRules);
    expect(result.some((p) => p.label === "Farming advice")).toBe(true);
  });

  it("includes drone prompt when drone activity selected", () => {
    const weather = makeWeather();
    const result = generateSuggestedPrompts(weather, loc, ["drone-flying"], sampleRules);
    expect(result.some((p) => p.label === "Drone conditions")).toBe(true);
  });

  it("includes exercise prompt when sports activities selected", () => {
    const weather = makeWeather();
    const result = generateSuggestedPrompts(weather, loc, ["running"], sampleRules);
    expect(result.some((p) => p.label === "Best time to exercise")).toBe(true);
  });

  it("prioritizes weather-condition prompts over activity prompts", () => {
    const weather = makeWeather({ weather_code: 95, temperature_2m: 38, uv_index: 10 });
    const result = generateSuggestedPrompts(weather, loc, ["running", "maize-farming"], sampleRules);
    expect(result[0].label).toBe("Storm safety");
    expect(result[1].label).toBe("Heat safety");
    expect(result[2].label).toBe("UV protection");
  });

  it("includes location name in query text", () => {
    const weather = makeWeather();
    const result = generateSuggestedPrompts(weather, loc, [], sampleRules);
    for (const prompt of result) {
      expect(prompt.query).toContain("Harare");
    }
  });

  it("deduplicates prompts by label", () => {
    const weather = makeWeather();
    const result = generateSuggestedPrompts(weather, loc, [], sampleRules);
    const labels = result.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("returns SuggestedPrompt shaped objects", () => {
    const weather = makeWeather();
    const result = generateSuggestedPrompts(weather, loc, [], sampleRules);
    for (const prompt of result) {
      expect(prompt).toHaveProperty("label");
      expect(prompt).toHaveProperty("query");
      expect(typeof prompt.label).toBe("string");
      expect(typeof prompt.query).toBe("string");
    }
  });

  it("interpolates temperature in heat query", () => {
    const weather = makeWeather({ temperature_2m: 38 });
    const result = generateSuggestedPrompts(weather, loc, [], sampleRules);
    const heatPrompt = result.find((p) => p.label === "Heat safety");
    expect(heatPrompt?.query).toContain("38°C");
  });

  it("interpolates UV index in UV query", () => {
    const weather = makeWeather({ uv_index: 9 });
    const result = generateSuggestedPrompts(weather, loc, [], sampleRules);
    const uvPrompt = result.find((p) => p.label === "UV protection");
    expect(uvPrompt?.query).toContain("9");
  });

  it("interpolates wind speed in wind query", () => {
    const weather = makeWeather({ wind_speed_10m: 35 });
    const result = generateSuggestedPrompts(weather, loc, [], sampleRules);
    const windPrompt = result.find((p) => p.label === "Wind impact");
    expect(windPrompt?.query).toContain("35");
  });

  it("skips inactive rules", () => {
    const inactiveRules = sampleRules.map((r) => ({ ...r, active: false }));
    const weather = makeWeather({ weather_code: 95 });
    const result = generateSuggestedPrompts(weather, loc, [], inactiveRules);
    expect(result).toHaveLength(0);
  });

  it("falls back to hardcoded prompts when no rules provided and cache empty", () => {
    const weather = makeWeather({ weather_code: 95 });
    const result = generateSuggestedPrompts(weather, loc, []);
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some((p) => p.label === "Storm safety")).toBe(true);
  });

  it("evaluates hourly data source for rain forecast rule", () => {
    const weather = makeWeather();
    weather.hourly.precipitation_probability = [80];
    const result = generateSuggestedPrompts(weather, loc, [], sampleRules);
    expect(result.some((p) => p.label === "Rain impact")).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { getActivityTips, MAX_TIPS } from "./activity-tips";
import type { WeatherData } from "./weather";

// ---------------------------------------------------------------------------
// Fixtures — minimal WeatherData with controllable hourly values
// ---------------------------------------------------------------------------

function makeWeather(
  hourlyOverrides: Partial<Record<string, number[]>> = {},
  currentOverrides: Partial<Record<string, number>> = {},
): WeatherData {
  const n = 24;
  const start = new Date();
  start.setHours(new Date().getHours(), 0, 0, 0);
  const time = Array.from({ length: n }, (_, i) =>
    new Date(start.getTime() + i * 3600_000).toISOString(),
  );
  const fill = (v: number) => Array.from({ length: n }, () => v);
  return {
    current: {
      temperature_2m: 22,
      relative_humidity_2m: 50,
      weather_code: 0,
      wind_speed_10m: 10,
      wind_gusts_10m: 15,
      uv_index: 4,
      ...currentOverrides,
    },
    hourly: {
      time,
      temperature_2m: fill(22),
      precipitation_probability: fill(10),
      wind_speed_10m: fill(10),
      wind_gusts_10m: fill(15),
      uv_index: fill(4),
      weather_code: fill(0),
      ...hourlyOverrides,
    },
    daily: {},
  } as unknown as WeatherData;
}

const farming = { id: "crop-farming", category: "farming" as const, label: "Maize & Crop Farming" };
const sports = { id: "running", category: "sports" as const, label: "Running" };
const casual = { id: "barbecue", category: "casual" as const, label: "Braai" };

// ---------------------------------------------------------------------------

describe("getActivityTips", () => {
  it("always returns at least one tip and never more than MAX_TIPS", () => {
    const calm = getActivityTips(farming, makeWeather());
    expect(calm.length).toBeGreaterThanOrEqual(1);

    // Trigger everything at once: storm + rain + wind + UV + heat
    const chaos = makeWeather({
      weather_code: Array(24).fill(95),
      precipitation_probability: Array(24).fill(90),
      wind_speed_10m: Array(24).fill(45),
      uv_index: Array(24).fill(10),
      temperature_2m: Array(24).fill(36),
    });
    expect(getActivityTips(farming, chaos).length).toBeLessThanOrEqual(MAX_TIPS);
  });

  it("returns a calm-conditions tip mentioning the activity when nothing triggers", () => {
    const tips = getActivityTips(farming, makeWeather());
    expect(tips[0]).toContain("maize & crop farming");
  });

  it("leads with thunderstorm safety when storms are forecast", () => {
    const codes = Array(24).fill(0);
    codes[4] = 95;
    const tips = getActivityTips(sports, makeWeather({ weather_code: codes }));
    expect(tips[0]).toContain("Thunderstorms expected");
    expect(tips[0].toLowerCase()).toContain("lightning");
  });

  it("names the rain hour and gives category-specific advice", () => {
    const prob = Array(24).fill(10);
    prob[3] = 80; // rain 3 hours from now
    const tips = getActivityTips(farming, makeWeather({ precipitation_probability: prob }));
    const rainTip = tips.find((t) => t.includes("Rain likely around"));
    expect(rainTip).toBeDefined();
    expect(rainTip).toContain("spraying");
    // The named hour is a real HH:00 stamp
    expect(rainTip).toMatch(/\d{2}:00/);
  });

  it("warns farmers off spraying in strong wind", () => {
    const tips = getActivityTips(farming, makeWeather({ wind_speed_10m: Array(24).fill(35) }));
    expect(tips.some((t) => t.includes("hold off on spraying"))).toBe(true);
  });

  it("flags very high UV with category-appropriate wording", () => {
    const tips = getActivityTips(sports, makeWeather({ uv_index: Array(24).fill(9) }));
    expect(tips.some((t) => t.includes("UV will be very high"))).toBe(true);
  });

  it("flags frost risk for farming when temps drop to 3°C or below", () => {
    const temps = Array(24).fill(15);
    temps[20] = 1;
    const tips = getActivityTips(farming, makeWeather({ temperature_2m: temps }));
    expect(tips.some((t) => t.toLowerCase().includes("frost"))).toBe(true);
  });

  it("flags heat above 32°C", () => {
    const tips = getActivityTips(casual, makeWeather({ temperature_2m: Array(24).fill(34) }));
    expect(tips.some((t) => t.includes("heat"))).toBe(true);
  });

  it("adds fungal-pressure guidance for farming in high humidity", () => {
    const tips = getActivityTips(farming, makeWeather({}, { relative_humidity_2m: 88 }));
    expect(tips.some((t) => t.includes("fungal disease"))).toBe(true);
  });

  it("does not give farming-specific tips to non-farming activities", () => {
    const tips = getActivityTips(sports, makeWeather({}, { relative_humidity_2m: 88 }));
    expect(tips.some((t) => t.includes("fungal disease"))).toBe(false);
  });
});

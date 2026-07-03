/**
 * Tests for the public embed API route (/api/embed/current).
 * Covers the pure response shaper + weather-code / wind-direction helpers,
 * and validates route structure (CORS, IP-geo headers, cache-control).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { weatherLabel, windDir, shapeEmbedResponse } from "./shape";

const source = readFileSync(resolve(__dirname, "route.ts"), "utf-8");

const LOCATION = {
  name: "Harare",
  province: "Harare",
  slug: "harare",
  country: "ZW",
  lat: -17.83,
  lon: 31.05,
};

const WEATHER = {
  current: {
    temperature_2m: 24.4,
    apparent_temperature: 23.1,
    relative_humidity_2m: 55,
    weather_code: 2,
    wind_speed_10m: 9.2,
    wind_direction_10m: 135,
    is_day: 1,
  },
  daily: {
    time: ["2026-06-30", "2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05", "2026-07-06", "2026-07-07"],
    weather_code: [2, 3, 61, 0, 2, 2, 3, 1],
    temperature_2m_max: [27.6, 25, 22, 28, 27, 26, 24, 25],
    temperature_2m_min: [14.2, 13, 12, 15, 14, 13, 12, 13],
    precipitation_probability_max: [0, 20, 80, 0, 5, 10, 30, 0],
  },
};

describe("weatherLabel", () => {
  it("maps known WMO codes", () => {
    expect(weatherLabel(0)).toBe("Clear sky");
    expect(weatherLabel(2)).toBe("Partly cloudy");
    expect(weatherLabel(65)).toBe("Heavy rain");
    expect(weatherLabel(95)).toBe("Thunderstorm");
  });

  it("falls back to Unknown for unmapped codes", () => {
    expect(weatherLabel(999)).toBe("Unknown");
  });
});

describe("windDir", () => {
  it("maps degrees to compass points", () => {
    expect(windDir(0)).toBe("N");
    expect(windDir(90)).toBe("E");
    expect(windDir(135)).toBe("SE");
    expect(windDir(180)).toBe("S");
    expect(windDir(360)).toBe("N");
  });
});

describe("shapeEmbedResponse", () => {
  it("rounds current values and derives condition + wind direction", () => {
    const out = shapeEmbedResponse(WEATHER, LOCATION, "slug");
    expect(out.current.temp).toBe(24);
    expect(out.current.feelsLike).toBe(23);
    expect(out.current.condition).toBe("Partly cloudy");
    expect(out.current.windDirection).toBe("SE");
    expect(out.current.isDay).toBe(true);
    expect(out.current.humidity).toBe(55);
  });

  it("pulls today's high/low from the first daily entry", () => {
    const out = shapeEmbedResponse(WEATHER, LOCATION, "slug");
    expect(out.current.high).toBe(28);
    expect(out.current.low).toBe(14);
  });

  it("caps the daily array at 7 entries and labels the first as Today", () => {
    const out = shapeEmbedResponse(WEATHER, LOCATION, "slug");
    expect(out.daily).toHaveLength(7);
    expect(out.daily[0].day).toBe("Today");
    expect(out.daily[2].condition).toBe("Rain");
    expect(out.daily[2].precipitationProbability).toBe(80);
  });

  it("builds an attribution URL from the slug", () => {
    const out = shapeEmbedResponse(WEATHER, LOCATION, "slug", "https://example.com");
    expect(out.attribution.url).toBe("https://example.com/harare");
    expect(out.attribution.name).toBe("mukoko weather");
  });

  it("is resilient to a null weather payload", () => {
    const out = shapeEmbedResponse(null, LOCATION, "ip");
    expect(out.current.temp).toBeNull();
    expect(out.daily).toEqual([]);
    expect(out.source).toBe("ip");
  });

  it("falls back to the site root when the location has no slug", () => {
    const out = shapeEmbedResponse(WEATHER, { ...LOCATION, slug: "" }, "ip", "https://example.com");
    expect(out.attribution.url).toBe("https://example.com");
  });
});

describe("route structure", () => {
  it("runs on the edge runtime", () => {
    expect(source).toContain('export const runtime = "edge"');
  });

  it("exports GET and OPTIONS handlers", () => {
    expect(source).toContain("export async function GET");
    expect(source).toContain("export async function OPTIONS");
  });

  it("sets permissive CORS for a public embed endpoint", () => {
    expect(source).toContain('"Access-Control-Allow-Origin": "*"');
  });

  it("derives location from Vercel IP-geo headers when unparameterised", () => {
    expect(source).toContain("x-vercel-ip-latitude");
    expect(source).toContain("x-vercel-ip-longitude");
  });

  it("calls the existing internal geo + weather endpoints", () => {
    expect(source).toContain("/api/py/weather");
    expect(source).toContain("/api/py/geo");
    expect(source).toContain("/api/py/locations");
  });

  it("unwraps the { location: {…} } wrapper from the locations endpoint", () => {
    // The locations endpoint returns `{ location: {…} }`, not a bare doc.
    // Reading `loc.lat` directly would be undefined → NaN → a silent Harare
    // fallback for every non-Harare slug embed. Guard that the unwrap stays.
    expect(source).toContain("?.location");
  });

  it("resolves weather by the resolved lat/lon (never a hardcoded default)", () => {
    expect(source).toContain("/api/py/weather?lat=${lat}&lon=${lon}");
  });

  it("does not shared-cache IP-derived responses", () => {
    expect(source).toContain("private, max-age=300");
    expect(source).toContain("Cache-Control");
  });
});

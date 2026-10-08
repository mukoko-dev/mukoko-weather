import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AQI_ADVICE,
  AQI_TEXT_CLASS,
  DISPLAY_DEFAULT_LAYER,
  DISPLAY_REFRESH_MS,
  currentHourIndex,
  displayUrl,
  isAirQuality,
  isDisplayWeather,
  nextHourIndexes,
  parseDisplayParams,
} from "./display";
import { AQI_LEVEL_LABELS } from "@/components/weather/AirQualityCard";
import { MAP_LAYERS } from "./map-layers";

describe("parseDisplayParams", () => {
  it("defaults to radar, no location, device theme", () => {
    expect(parseDisplayParams({})).toEqual({
      location: null,
      coords: null,
      layer: DISPLAY_DEFAULT_LAYER,
      theme: null,
    });
  });

  it("radar is a real map layer", () => {
    expect(MAP_LAYERS.some((l) => l.id === DISPLAY_DEFAULT_LAYER)).toBe(true);
  });

  it("accepts a valid slug, lowercased", () => {
    expect(parseDisplayParams({ location: "Harare" }).location).toBe("harare");
    expect(parseDisplayParams({ location: "singapore-sg" }).location).toBe(
      "singapore-sg",
    );
  });

  it("rejects slugs with unsafe characters", () => {
    expect(parseDisplayParams({ location: "../etc" }).location).toBeNull();
    expect(parseDisplayParams({ location: "a b" }).location).toBeNull();
    expect(
      parseDisplayParams({ location: "x".repeat(81) }).location,
    ).toBeNull();
  });

  it("takes the first value of a repeated param", () => {
    expect(
      parseDisplayParams({ location: ["harare", "bulawayo"] }).location,
    ).toBe("harare");
  });

  it("parses coordinates and requires both", () => {
    expect(parseDisplayParams({ lat: "1.35", lon: "103.82" }).coords).toEqual({
      lat: 1.35,
      lon: 103.82,
    });
    expect(parseDisplayParams({ lat: "1.35" }).coords).toBeNull();
    expect(parseDisplayParams({ lat: "", lon: "" }).coords).toBeNull();
  });

  it("rejects out-of-range or non-numeric coordinates", () => {
    expect(parseDisplayParams({ lat: "91", lon: "0" }).coords).toBeNull();
    expect(parseDisplayParams({ lat: "0", lon: "-181" }).coords).toBeNull();
    expect(parseDisplayParams({ lat: "abc", lon: "1" }).coords).toBeNull();
    expect(parseDisplayParams({ lat: "Infinity", lon: "1" }).coords).toBeNull();
  });

  it("only accepts known map layers", () => {
    expect(parseDisplayParams({ layer: "cloudCover" }).layer).toBe(
      "cloudCover",
    );
    expect(parseDisplayParams({ layer: "nope" }).layer).toBe(
      DISPLAY_DEFAULT_LAYER,
    );
  });

  it("only accepts light or dark themes", () => {
    expect(parseDisplayParams({ theme: "dark" }).theme).toBe("dark");
    expect(parseDisplayParams({ theme: "light" }).theme).toBe("light");
    expect(parseDisplayParams({ theme: "system" }).theme).toBeNull();
  });
});

describe("AQI advice", () => {
  it("covers every EPA level with advice and a severity token", () => {
    for (const level of Object.keys(AQI_LEVEL_LABELS)) {
      expect(AQI_ADVICE[level as keyof typeof AQI_ADVICE]).toBeTruthy();
      expect(AQI_TEXT_CLASS[level as keyof typeof AQI_TEXT_CLASS]).toMatch(
        /^text-severity-/,
      );
    }
  });

  it("tells people what to do in haze", () => {
    expect(AQI_ADVICE.unhealthy).toMatch(/mask/i);
    expect(AQI_ADVICE.very_unhealthy).toMatch(/indoors/i);
    expect(AQI_ADVICE.hazardous).toMatch(/indoors/i);
  });
});

describe("hour slicing", () => {
  const day = (h: number) => `2026-10-08T${String(h).padStart(2, "0")}:00`;
  const times = Array.from({ length: 24 }, (_, h) => day(h));

  it("finds the current hour", () => {
    expect(currentHourIndex(times, new Date(2026, 9, 8, 14, 35))).toBe(14);
  });

  it("falls back to 0 when the forecast doesn't cover now", () => {
    expect(currentHourIndex(times, new Date(2026, 9, 9, 3))).toBe(0);
  });

  it("steps through the next hours and stops at the end", () => {
    expect(nextHourIndexes(times, new Date(2026, 9, 8, 14), 4, 2)).toEqual([
      14, 16, 18, 20,
    ]);
    expect(nextHourIndexes(times, new Date(2026, 9, 8, 20), 8, 2)).toEqual([
      20, 22,
    ]);
  });
});

describe("displayUrl", () => {
  it("builds a bookmarkable URL and omits defaults", () => {
    expect(
      displayUrl("https://weather.mukoko.com", { location: "harare" }),
    ).toBe("https://weather.mukoko.com/display?location=harare");
    expect(
      displayUrl("https://weather.mukoko.com", {
        location: "singapore-sg",
        layer: "cloudCover",
        theme: "dark",
      }),
    ).toBe(
      "https://weather.mukoko.com/display?location=singapore-sg&layer=cloudCover&theme=dark",
    );
  });
});

describe("response guards", () => {
  const weather = {
    current: { temperature_2m: 24 },
    hourly: { time: ["2026-10-08T00:00"] },
    daily: { time: ["2026-10-08"] },
  };

  it("accepts a weather payload and rejects error bodies", () => {
    expect(isDisplayWeather(weather)).toBe(true);
    expect(isDisplayWeather({ error: "upstream" })).toBe(false);
    expect(isDisplayWeather(null)).toBe(false);
    expect(isDisplayWeather({ ...weather, daily: { time: [] } })).toBe(false);
  });

  it("accepts an AQI payload with a known level only", () => {
    expect(isAirQuality({ aqi: 168, level: "unhealthy" })).toBe(true);
    expect(isAirQuality({ aqi: 168, level: "smoky" })).toBe(false);
    expect(isAirQuality({ aqi: Number.NaN, level: "good" })).toBe(false);
    expect(isAirQuality({ error: "x" })).toBe(false);
  });
});

describe("refresh cadence", () => {
  it("polls weather more often than air quality, and reloads rarely", () => {
    expect(DISPLAY_REFRESH_MS.weather).toBeLessThan(
      DISPLAY_REFRESH_MS.airQuality,
    );
    expect(DISPLAY_REFRESH_MS.airQuality).toBeLessThan(
      DISPLAY_REFRESH_MS.reload,
    );
  });
});

describe("display route wiring", () => {
  const root = join(__dirname, "..");
  const read = (p: string) => readFileSync(join(root, p), "utf8");

  it("is reserved so it never becomes the lastLocation cookie", () => {
    expect(read("proxy.ts")).toMatch(/"display"/);
    expect(read("components/weather/WeatherLoadingScene.tsx")).toMatch(
      /"display"/,
    );
  });

  it("keeps the screen awake and reloads periodically", () => {
    const dash = read("app/display/DisplayDashboard.tsx");
    expect(dash).toContain("useWakeLock()");
    expect(dash).toContain("usePeriodicReload()");
  });

  it("isolates every panel in an error boundary", () => {
    const dash = read("app/display/DisplayDashboard.tsx");
    const boundaries = dash.match(/<ChartErrorBoundary/g) ?? [];
    expect(boundaries.length).toBeGreaterThanOrEqual(5);
  });

  it("uses no hardcoded colours or inline styles", () => {
    for (const p of [
      "app/display/DisplayDashboard.tsx",
      "app/display/loading.tsx",
      "components/display/DisplayPanels.tsx",
    ]) {
      const src = read(p);
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src).not.toMatch(/rgba?\(/);
      expect(src).not.toMatch(/style=\{\{/);
    }
  });

  it("is not indexed (kiosk duplicate of /{slug})", () => {
    expect(read("app/display/page.tsx")).toMatch(/index: false/);
  });
});

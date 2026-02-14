/**
 * Tests for weather-icons.tsx — validates the ActivityIcon and WeatherIcon
 * switch mappings by reading the source file and verifying every expected
 * mapping is present.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "weather-icons.tsx"),
  "utf-8",
);

describe("ActivityIcon mapping", () => {
  const expectedActivities = [
    "crop-farming",
    "livestock",
    "gardening",
    "mining",
    "construction",
    "driving",
    "commuting",
    "safari",
    "photography",
    "birdwatching",
    "running",
    "cycling",
    "hiking",
    "football",
    "swimming",
    "golf",
    "cricket",
    "walking",
    "barbecue",
    "outdoor-events",
  ];

  it("maps all 20 activity IDs", () => {
    for (const id of expectedActivities) {
      expect(source).toContain(`case "${id}"`);
    }
  });

  it("has a default fallback to SunIcon", () => {
    // Find the ActivityIcon function and verify it has a default case
    const activityIconMatch = source.match(
      /function ActivityIcon[\s\S]*?^}/m,
    );
    expect(activityIconMatch).toBeTruthy();
    expect(activityIconMatch![0]).toContain("default:");
    expect(activityIconMatch![0]).toContain("SunIcon");
  });

  it("has exactly 20 activity cases (no duplicates or missing)", () => {
    // Extract the ActivityIcon switch block
    const activityIconSection = source.slice(
      source.indexOf("function ActivityIcon"),
      source.indexOf("function WeatherIcon"),
    );
    const caseMatches = activityIconSection.match(/case "/g);
    expect(caseMatches).toHaveLength(20);
  });
});

describe("WeatherIcon mapping", () => {
  const expectedIcons = [
    "sun",
    "cloud",
    "cloud-sun",
    "cloud-rain",
    "cloud-drizzle",
    "cloud-lightning",
    "cloud-fog",
    "cloud-sun-rain",
    "cloud-hail",
    "snowflake",
  ];

  it("maps all 10 weather icon names", () => {
    for (const icon of expectedIcons) {
      expect(source).toContain(`case "${icon}"`);
    }
  });

  it("has a default fallback to CloudIcon", () => {
    const weatherIconMatch = source.match(
      /function WeatherIcon[\s\S]*$/m,
    );
    expect(weatherIconMatch).toBeTruthy();
    expect(weatherIconMatch![0]).toContain("default:");
    expect(weatherIconMatch![0]).toContain("CloudIcon");
  });

  it("has exactly 10 weather icon cases", () => {
    const weatherIconSection = source.slice(
      source.indexOf("function WeatherIcon"),
    );
    const caseMatches = weatherIconSection.match(/case "/g);
    expect(caseMatches).toHaveLength(10);
  });
});

describe("Icon components", () => {
  const allExportedIcons = [
    "SunIcon", "MoonIcon", "CloudIcon", "CloudSunIcon", "CloudRainIcon",
    "CloudDrizzleIcon", "CloudLightningIcon", "CloudFogIcon", "CloudSunRainIcon",
    "CloudHailIcon", "SnowflakeIcon", "WindIcon", "DropletIcon", "ThermometerIcon",
    "SunriseIcon", "SunsetIcon", "EyeIcon", "GaugeIcon", "ClockIcon",
    "SearchIcon", "MapPinIcon", "SparklesIcon",
    "CropIcon", "LivestockIcon", "ShovelIcon", "PickaxeIcon", "HardHatIcon",
    "CarIcon", "BusIcon", "BinocularsIcon", "BirdIcon", "RunningIcon",
    "BicycleIcon", "MountainIcon", "FootballIcon", "SwimmingIcon", "GolfIcon",
    "CricketIcon", "FootprintsIcon", "GrillIcon", "TentIcon", "CameraIcon",
  ];

  it("exports all icon components", () => {
    for (const icon of allExportedIcons) {
      expect(source).toContain(`export function ${icon}`);
    }
  });

  it("all icon functions accept className and size props", () => {
    for (const icon of allExportedIcons) {
      const funcPattern = new RegExp(
        `function ${icon}\\(\\{\\s*className\\s*=\\s*""\\s*,\\s*size\\s*=\\s*24`,
      );
      expect(source).toMatch(funcPattern);
    }
  });

  it("all icons render <svg> elements with viewBox", () => {
    // Each icon function should contain viewBox="0 0 24 24"
    const svgCount = (source.match(/viewBox="0 0 24 24"/g) || []).length;
    // Should be at least as many as exported icons (44 icons + 2 mapper functions)
    expect(svgCount).toBeGreaterThanOrEqual(allExportedIcons.length);
  });
});

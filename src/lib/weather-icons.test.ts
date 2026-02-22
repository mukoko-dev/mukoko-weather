/**
 * Tests for weather-icons.tsx — validates the ICON_REGISTRY, ActivityIcon,
 * and WeatherIcon mappings by reading the source file and verifying every
 * expected mapping is present.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "weather-icons.tsx"),
  "utf-8",
);

describe("ICON_REGISTRY", () => {
  const expectedIcons = [
    "crop", "livestock", "shovel", "water", "pickaxe", "hardhat",
    "car", "bus", "plane", "binoculars", "camera", "bird", "tent",
    "star", "fish", "running", "bicycle", "mountain", "football",
    "swimming", "golf", "cricket", "tennis", "rugby", "horse",
    "footprints", "grill", "drone", "picnic", "sparkles", "sun",
  ];

  it("maps all 31 icon identifiers in the registry", () => {
    for (const id of expectedIcons) {
      expect(source).toContain(`${id}:`);
    }
  });

  it("exports the ICON_REGISTRY", () => {
    expect(source).toContain("export const ICON_REGISTRY");
  });

  it("has exactly 31 entries in the registry", () => {
    // Count entries between ICON_REGISTRY and the closing brace
    const registryStart = source.indexOf("export const ICON_REGISTRY");
    const registrySection = source.slice(registryStart, source.indexOf("};", registryStart) + 2);
    // Count lines that have an icon mapping (identifier: ComponentName)
    const entryMatches = registrySection.match(/^\s+\w+:\s+\w+Icon,?$/gm);
    expect(entryMatches).toHaveLength(31);
  });
});

describe("ActivityIcon component", () => {
  it("exports the ActivityIcon function", () => {
    expect(source).toContain("export function ActivityIcon");
  });

  it("accepts activity and icon props", () => {
    expect(source).toContain("activity: string");
    expect(source).toContain("icon?: string");
  });

  it("looks up icon from ICON_REGISTRY", () => {
    expect(source).toContain("ICON_REGISTRY[icon]");
  });

  it("falls back to SunIcon for unknown icons", () => {
    const activityIconSection = source.slice(
      source.indexOf("export function ActivityIcon"),
      source.indexOf("export function WeatherIcon"),
    );
    expect(activityIconSection).toContain("SunIcon");
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
    "ShareIcon",
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

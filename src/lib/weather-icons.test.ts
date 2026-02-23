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
  // Original icons + expanded icons for broadened activity categories
  const expectedIcons = [
    // Agriculture & Forestry
    "crop", "livestock", "shovel", "water", "tree", "bee", "leaf",
    // Industry & Construction
    "pickaxe", "hardhat", "factory", "bolt", "box",
    // Transport & Logistics
    "car", "bus", "plane", "truck", "ship",
    // Outdoors & Conservation
    "binoculars", "camera", "bird", "tent", "star", "fish", "anchor",
    "shield", "pawprint", "mountain",
    // Sports & Fitness
    "running", "bicycle", "football", "swimming", "golf", "cricket",
    "tennis", "rugby", "horse", "trophy", "whistle",
    // Lifestyle & Events
    "footprints", "grill", "drone", "picnic", "sparkles", "calendar",
    "music", "heartpulse", "graduationcap",
    // Default
    "sun",
  ];

  it("maps all expected icon identifiers in the registry", () => {
    for (const id of expectedIcons) {
      expect(source).toContain(`${id}:`);
    }
  });

  it("exports the ICON_REGISTRY", () => {
    expect(source).toContain("export const ICON_REGISTRY");
  });

  it("every expected icon has a corresponding entry in the registry", () => {
    // Verify every icon in our expectedIcons list is registered — the
    // registry can grow beyond this list (via Lucide fallback) without
    // requiring test updates.
    for (const id of expectedIcons) {
      expect(source).toContain(`${id}:`);
    }
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

  it("looks up icon from custom ICON_REGISTRY first", () => {
    expect(source).toContain("ICON_REGISTRY[icon]");
  });

  it("falls back to Lucide icons for dynamic resolution", () => {
    expect(source).toContain("lucideIcons");
    expect(source).toContain("toPascalCase");
  });

  it("falls back to SunIcon as final default", () => {
    const activityIconSection = source.slice(
      source.indexOf("export function ActivityIcon"),
      source.indexOf("export function WeatherIcon"),
    );
    expect(activityIconSection).toContain("SunIcon");
  });

  it("imports lucide-react icons for scalable icon resolution", () => {
    expect(source).toContain('import { icons as lucideIcons } from "lucide-react"');
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
    // Weather icons
    "SunIcon", "MoonIcon", "CloudIcon", "CloudSunIcon", "CloudRainIcon",
    "CloudDrizzleIcon", "CloudLightningIcon", "CloudFogIcon", "CloudSunRainIcon",
    "CloudHailIcon", "SnowflakeIcon", "WindIcon", "DropletIcon", "ThermometerIcon",
    "SunriseIcon", "SunsetIcon", "EyeIcon", "GaugeIcon", "ClockIcon",
    "SearchIcon", "MapPinIcon", "SparklesIcon", "ShareIcon",
    // Original activity icons
    "CropIcon", "LivestockIcon", "ShovelIcon", "PickaxeIcon", "HardHatIcon",
    "CarIcon", "BusIcon", "BinocularsIcon", "BirdIcon", "RunningIcon",
    "BicycleIcon", "MountainIcon", "FootballIcon", "SwimmingIcon", "GolfIcon",
    "CricketIcon", "FootprintsIcon", "GrillIcon", "TentIcon", "CameraIcon",
    // Expanded activity icons
    "TreeIcon", "BeeIcon", "LeafIcon", "AnchorIcon", "FactoryIcon",
    "BoltIcon", "TruckIcon", "ShipIcon", "ShieldIcon", "PawPrintIcon",
    "TrophyIcon", "WhistleIcon", "CalendarIcon", "MusicIcon",
    "HeartPulseIcon", "GraduationCapIcon", "BoxIcon",
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

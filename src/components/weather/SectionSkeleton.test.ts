/**
 * Tests for the shared skeleton layer — verifies that the sub-route loading
 * boundaries and the map placeholder compose the shared skeleton components
 * instead of hand-rolling their own, and that removed skeleton exports stay
 * removed. Reads source files (Vitest runs in Node without a DOM).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf-8");

const sectionSkeleton = read("SectionSkeleton.tsx");
const uiSkeleton = read("../ui/skeleton.tsx");
const mapSkeleton = read("map/MapSkeleton.tsx");
const forecastLoading = read("../../app/[location]/forecast/loading.tsx");
const atmosphereLoading = read("../../app/[location]/atmosphere/loading.tsx");
const mapLoading = read("../../app/[location]/map/loading.tsx");

describe("SectionSkeleton — removed unused exports", () => {
  it.each([
    "HourlyScrollCardsSkeleton",
    "AtmosphericSummarySkeleton",
    "SunTimesSkeleton",
  ])("%s is no longer exported", (name) => {
    expect(sectionSkeleton).not.toContain(name);
  });

  it("keeps the skeletons the forecast loading boundary composes", () => {
    expect(sectionSkeleton).toContain("export function HourlyForecastSkeleton");
    expect(sectionSkeleton).toContain("export function DailyForecastSkeleton");
  });
});

describe("ui/skeleton — removed unused exports", () => {
  it("no longer exports BadgeSkeleton", () => {
    expect(uiSkeleton).not.toContain("BadgeSkeleton");
  });

  it("still exports MetricCardSkeleton and ChartSkeleton for the atmosphere boundary", () => {
    expect(uiSkeleton).toContain("MetricCardSkeleton,");
    expect(uiSkeleton).toContain("ChartSkeleton,");
  });
});

describe("sub-route loading boundaries compose shared skeletons", () => {
  it("forecast renders HourlyForecastSkeleton and DailyForecastSkeleton", () => {
    expect(forecastLoading).toContain("<HourlyForecastSkeleton />");
    expect(forecastLoading).toContain("<DailyForecastSkeleton />");
    expect(forecastLoading).not.toContain("pangolin");
  });

  it("atmosphere renders MetricCardSkeleton grid and ChartSkeleton", () => {
    expect(atmosphereLoading).toContain("<MetricCardSkeleton");
    expect(atmosphereLoading).toContain("<ChartSkeleton");
    expect(atmosphereLoading).not.toContain("pangolin");
  });

  it("map renders the shared MapSkeleton full-height, unrounded, as MapDashboard does", () => {
    expect(mapLoading).toContain(
      '<MapSkeleton fill className="rounded-none" />',
    );
    expect(mapLoading).not.toContain("animate-pulse");
    expect(mapLoading).not.toContain("grid-cols-4");
  });

  it("every loading boundary keeps the header and breadcrumb skeletons", () => {
    for (const src of [forecastLoading, atmosphereLoading, mapLoading]) {
      expect(src).toContain("<HeaderSkeleton />");
      expect(src).toContain("<BreadcrumbSkeleton");
    }
  });
});

describe("MapSkeleton — class composition", () => {
  it("merges className with cn() so overrides such as rounded-none win", () => {
    expect(mapSkeleton).toContain('import { cn } from "@/lib/utils"');
    expect(mapSkeleton).toContain("className={cn(");
    expect(mapSkeleton).not.toContain("${className");
  });

  it("keeps the status role and accessible label", () => {
    expect(mapSkeleton).toContain('role="status"');
    expect(mapSkeleton).toContain('aria-label="Loading map"');
  });
});

/**
 * Tests for WeatherLoadingScene — validates the branded loading animation
 * component including KNOWN_ROUTES guard, reduced-motion support, slug
 * extraction, and Three.js scene integration.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "WeatherLoadingScene.tsx"),
  "utf-8",
);

describe("WeatherLoadingScene — component structure", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("exports WeatherLoadingScene as a named export", () => {
    expect(source).toContain("export function WeatherLoadingScene");
  });

  it("accepts slug and statusText props", () => {
    expect(source).toContain("slug?: string");
    expect(source).toContain("statusText?: string");
  });

  it("uses usePathname for slug extraction fallback", () => {
    expect(source).toContain("usePathname");
    expect(source).toContain("pathnameSlug");
  });
});

describe("WeatherLoadingScene — KNOWN_ROUTES guard", () => {
  it("defines KNOWN_ROUTES at module level (not per-render)", () => {
    // KNOWN_ROUTES should appear before the component function
    const knownRoutesIndex = source.indexOf("KNOWN_ROUTES");
    const exportFunctionIndex = source.indexOf("export function WeatherLoadingScene");
    expect(knownRoutesIndex).toBeLessThan(exportFunctionIndex);
  });

  it("guards against known app routes being used as location slugs", () => {
    expect(source).toContain("KNOWN_ROUTES.has(pathnameSlug)");
  });

  it("includes all major app routes in guard set", () => {
    expect(source).toContain('"explore"');
    expect(source).toContain('"shamwari"');
    expect(source).toContain('"history"');
    expect(source).toContain('"about"');
    expect(source).toContain('"help"');
    expect(source).toContain('"privacy"');
    expect(source).toContain('"terms"');
    expect(source).toContain('"status"');
    expect(source).toContain('"embed"');
  });
});

describe("WeatherLoadingScene — reduced motion", () => {
  it("checks prefers-reduced-motion media query", () => {
    expect(source).toContain("prefers-reduced-motion: reduce");
  });

  it("conditionally renders 3D scene based on use3D state", () => {
    expect(source).toContain("use3D");
    expect(source).toContain("setUse3D");
  });

  it("shows text-only fallback when 3D is disabled", () => {
    // The loading overlay with branded text always renders
    expect(source).toContain("mukoko");
    expect(source).toContain("weather");
    expect(source).toContain("animate-pulse");
  });

  it("defers media query detection to avoid SSR mismatch", () => {
    // useState defaults false (SSR-safe), then rAF sets real value
    expect(source).toContain("requestAnimationFrame");
    expect(source).toContain("cancelAnimationFrame");
  });
});

describe("WeatherLoadingScene — Three.js integration", () => {
  it("imports createWeatherScene from weather-scenes", () => {
    expect(source).toContain("createWeatherScene");
  });

  it("imports resolveScene for weather code mapping", () => {
    expect(source).toContain("resolveScene");
  });

  it("imports getCachedWeatherHint for scene selection", () => {
    expect(source).toContain("getCachedWeatherHint");
  });

  it("defaults to partly-cloudy when no hint available", () => {
    expect(source).toContain('"partly-cloudy"');
  });

  it("disposes scene on unmount", () => {
    expect(source).toContain("dispose");
    expect(source).toContain("disposed = true");
  });

  it("handles Three.js load failure gracefully", () => {
    expect(source).toContain(".catch(");
  });
});

describe("WeatherLoadingScene — display", () => {
  it("formats slug for display as title case", () => {
    expect(source).toContain("locationDisplay");
    expect(source).toContain("toUpperCase");
  });

  it("shows location-specific loading text", () => {
    expect(source).toContain("Loading");
    expect(source).toContain("weather...");
  });

  it("shows generic text when no location is available", () => {
    expect(source).toContain("Preparing your forecast");
  });

  it("uses sr-only text for screen readers", () => {
    expect(source).toContain("sr-only");
    expect(source).toContain("Loading weather data");
  });
});

describe("WeatherLoadingScene — accessibility", () => {
  it("marks 3D canvas as aria-hidden", () => {
    expect(source).toContain('aria-hidden="true"');
  });

  it("has a status role for the loading indicator", () => {
    expect(source).toContain('role="status"');
  });
});

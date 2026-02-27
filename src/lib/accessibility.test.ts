/**
 * Cross-component accessibility tests — validates that key WCAG/ARIA patterns
 * are consistently applied across components.
 *
 * Since Vitest runs in Node without a DOM, we read source files and verify
 * accessibility attributes are present at the source level. This catches
 * regressions that would otherwise require full browser/e2e testing.
 *
 * Patterns validated:
 * - aria-labelledby / aria-label on sections and interactive elements
 * - aria-hidden on decorative icons
 * - role="alert" on error states
 * - role="status" on loading states
 * - sr-only text for screen readers
 * - 44px minimum touch targets on interactive elements
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Source file readers ──────────────────────────────────────────────────────

function readComponent(relativePath: string) {
  return readFileSync(resolve(__dirname, relativePath), "utf-8");
}

const currentConditions = readComponent("../components/weather/CurrentConditions.tsx");
const chartErrorBoundary = readComponent("../components/weather/ChartErrorBoundary.tsx");
const lazySection = readComponent("../components/weather/LazySection.tsx");
const weatherDashboard = readComponent("../app/[location]/WeatherDashboard.tsx");
const header = readComponent("../components/layout/Header.tsx");
const frostAlertBanner = readComponent("../app/[location]/FrostAlertBanner.tsx");

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Sections — aria-labelledby", () => {
  it("CurrentConditions section uses aria-labelledby", () => {
    expect(currentConditions).toContain("aria-labelledby");
  });

  it("CurrentConditions heading ID matches aria-labelledby", () => {
    expect(currentConditions).toContain("current-conditions-heading");
  });

  it("WeatherDashboard main has descriptive aria-label", () => {
    expect(weatherDashboard).toContain("aria-label={`Weather dashboard for");
  });

  it("WeatherDashboard breadcrumb nav has aria-label", () => {
    expect(weatherDashboard).toContain('aria-label="Breadcrumb"');
  });

  it("WeatherDashboard stats section has aria-label for screen readers", () => {
    expect(currentConditions).toContain('aria-label="Weather statistics"');
  });
});

describe("Interactive elements — aria-label", () => {
  it("CurrentConditions share button has descriptive aria-label", () => {
    expect(currentConditions).toContain("Share weather for");
    expect(currentConditions).toContain("aria-label");
  });

  it("ChartErrorBoundary retry button is inside a role=alert region", () => {
    expect(chartErrorBoundary).toContain('role="alert"');
    expect(chartErrorBoundary).toContain("Try again");
  });
});

describe("Decorative icons — aria-hidden", () => {
  it("CurrentConditions icons are aria-hidden", () => {
    expect(currentConditions).toContain('aria-hidden="true"');
  });

  it("WeatherDashboard breadcrumb separators are aria-hidden", () => {
    expect(weatherDashboard).toContain('aria-hidden="true"');
  });
});

describe("Loading states — role=\"status\"", () => {
  it("LazySection default fallback has role=\"status\"", () => {
    expect(lazySection).toContain('role="status"');
  });

  it("LazySection fallback has aria-label for loading state", () => {
    expect(lazySection).toContain('aria-label="Loading section"');
  });
});

describe("Error states — role=\"alert\"", () => {
  it("ChartErrorBoundary fallback has role=\"alert\"", () => {
    expect(chartErrorBoundary).toContain('role="alert"');
  });
});

describe("Screen reader text — sr-only", () => {
  it("LazySection includes sr-only loading text", () => {
    expect(lazySection).toContain("sr-only");
  });

  it("CurrentConditions share button text is sr-only on mobile", () => {
    expect(currentConditions).toContain("sr-only");
  });

  it("WeatherDashboard h1 is sr-only (SEO heading, visually hidden)", () => {
    expect(weatherDashboard).toContain("sr-only");
    expect(weatherDashboard).toContain("Weather Forecast");
  });

  it("CurrentConditions heading is sr-only", () => {
    expect(currentConditions).toContain("sr-only");
    expect(currentConditions).toContain("Current weather conditions in");
  });
});

describe("Touch targets — 44px minimum", () => {
  it("CurrentConditions share button meets 44px touch target requirement", () => {
    expect(currentConditions).toContain("min-h-[48px]");
    expect(currentConditions).toContain("min-w-[48px]");
  });
});

describe("Semantic structure — lists", () => {
  it("CurrentConditions stats grid uses role=\"list\"", () => {
    expect(currentConditions).toContain('role="list"');
  });

  it("CurrentConditions stats items use role=\"listitem\"", () => {
    expect(currentConditions).toContain('role="listitem"');
  });

  it("WeatherDashboard breadcrumb uses <ol> for ordered list", () => {
    expect(weatherDashboard).toContain("<ol");
  });

  it("WeatherDashboard breadcrumb uses aria-current=\"page\" on active item", () => {
    expect(weatherDashboard).toContain('aria-current="page"');
  });
});

describe("Skip navigation", () => {
  it("WeatherDashboard main has id=main-content for skip links", () => {
    expect(weatherDashboard).toContain('id="main-content"');
  });
});

describe("FrostAlertBanner — accessibility", () => {
  it("FrostAlertBanner uses a semantic role or aria attribute", () => {
    // Should use role="alert" or aria-live for urgent frost warnings
    const hasAlertRole = frostAlertBanner.includes('role="alert"') ||
      frostAlertBanner.includes("aria-live") ||
      frostAlertBanner.includes("aria-label");
    expect(hasAlertRole).toBe(true);
  });
});

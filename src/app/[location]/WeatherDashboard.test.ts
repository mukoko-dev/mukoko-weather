/**
 * Tests for WeatherDashboard — validates section ordering, lazy loading
 * wrappers, error boundaries, and accessibility by reading the source file
 * (Vitest runs in Node without a DOM/React renderer).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "WeatherDashboard.tsx"),
  "utf-8",
);

describe("WeatherDashboard — section ordering (Google Weather pattern)", () => {
  it("renders HourlyForecast before AISummary in the left column", () => {
    const hourlyPos = source.indexOf('label="hourly-forecast"');
    const aiPos = source.indexOf('label="ai-summary"');
    expect(hourlyPos).toBeGreaterThan(-1);
    expect(aiPos).toBeGreaterThan(-1);
    expect(hourlyPos).toBeLessThan(aiPos);
  });

  it("renders ActivityInsights before DailyForecast", () => {
    const activityPos = source.indexOf('label="activity-insights"');
    const dailyPos = source.indexOf('label="daily-forecast"');
    expect(activityPos).toBeLessThan(dailyPos);
  });

  it("renders DailyForecast before AISummary", () => {
    const dailyPos = source.indexOf('label="daily-forecast"');
    const aiPos = source.indexOf('label="ai-summary"');
    expect(dailyPos).toBeLessThan(aiPos);
  });

  it("renders AISummary before AtmosphericSummary", () => {
    const aiPos = source.indexOf('label="ai-summary"');
    const atmosphericPos = source.indexOf('label="atmospheric-summary"');
    expect(aiPos).toBeLessThan(atmosphericPos);
  });

  it("renders CurrentConditions eagerly (before any LazySection)", () => {
    const currentPos = source.indexOf("<CurrentConditions");
    const firstLazy = source.indexOf("<LazySection");
    expect(currentPos).toBeGreaterThan(-1);
    expect(firstLazy).toBeGreaterThan(-1);
    expect(currentPos).toBeLessThan(firstLazy);
  });

  it("sidebar starts with SunTimes", () => {
    const sidebarStart = source.indexOf("Sidebar");
    const sunPos = source.indexOf('label="sun-times"');
    expect(sidebarStart).toBeLessThan(sunPos);
  });
});

describe("WeatherDashboard — lazy loading", () => {
  const lazySections = [
    "hourly-forecast",
    "ai-summary",
    "activity-insights",
    "atmospheric-summary",
    "daily-forecast",
    "sun-times",
    "weather-map",
    "location-info",
  ];

  it("wraps all non-critical sections in LazySection", () => {
    for (const label of lazySections) {
      expect(source).toContain(`label="${label}"`);
    }
  });

  it("imports LazySection component", () => {
    expect(source).toContain("LazySection");
    expect(source).toContain("@/components/weather/LazySection");
  });

  it("uses React.lazy for code-split heavy components", () => {
    expect(source).toContain("lazy(");
    expect(source).toContain("HourlyForecast");
    expect(source).toContain("AISummary");
  });

  it("wraps lazy components in Suspense with skeleton fallback", () => {
    expect(source).toContain("Suspense");
    expect(source).toContain("SectionSkeleton");
  });
});

describe("WeatherDashboard — error isolation", () => {
  it("imports ChartErrorBoundary", () => {
    expect(source).toContain("ChartErrorBoundary");
    expect(source).toContain("@/components/weather/ChartErrorBoundary");
  });

  it("wraps CurrentConditions in ChartErrorBoundary", () => {
    expect(source).toContain('name="current conditions"');
  });

  it("wraps HourlyForecast in ChartErrorBoundary", () => {
    expect(source).toContain('name="hourly forecast"');
  });

  it("wraps DailyForecast in ChartErrorBoundary", () => {
    expect(source).toContain('name="daily forecast"');
  });

  it("wraps AISummary in ChartErrorBoundary", () => {
    expect(source).toContain('name="AI summary"');
  });

  it("wraps all chart/data sections in ChartErrorBoundary", () => {
    const boundaryCount = (source.match(/<ChartErrorBoundary/g) || []).length;
    // Current + Hourly + Daily + AI + Activities + Atmospheric + Sun + Map = 8
    expect(boundaryCount).toBeGreaterThanOrEqual(8);
  });
});

describe("WeatherDashboard — accessibility", () => {
  it("main element has aria-label describing the dashboard", () => {
    expect(source).toContain("aria-label={`Weather dashboard for");
  });

  it("main element has id for skip navigation", () => {
    expect(source).toContain('id="main-content"');
  });

  it("h1 is present for SEO (visually hidden via sr-only)", () => {
    expect(source).toContain("sr-only");
    expect(source).toContain("Weather Forecast");
  });

  it("breadcrumb nav has aria-label", () => {
    expect(source).toContain('aria-label="Breadcrumb"');
  });

  it("breadcrumb separators are aria-hidden", () => {
    expect(source).toContain('aria-hidden="true"');
  });

  it("aria-current=\"page\" on the current location breadcrumb", () => {
    expect(source).toContain('aria-current="page"');
  });

  it("has an aria-live region for loading→loaded screen reader announcement", () => {
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("Weather loaded for");
  });
});

describe("WeatherDashboard — props and integration", () => {
  it("passes slug to CurrentConditions for share URL", () => {
    expect(source).toContain("slug={location.slug}");
  });

  it("conditionally renders AISummary only when not using fallback data", () => {
    expect(source).toContain("!usingFallback");
    expect(source).toContain("AISummary");
  });

  it("conditionally renders WeatherUnavailableBanner on fallback", () => {
    expect(source).toContain("usingFallback");
    expect(source).toContain("WeatherUnavailableBanner");
  });

  it("conditionally renders FrostAlertBanner when alert is present", () => {
    expect(source).toContain("frostAlert");
    expect(source).toContain("FrostAlertBanner");
  });

  it("syncs location to global store via useEffect", () => {
    expect(source).toContain("setSelectedLocation");
    expect(source).toContain("useEffect");
  });
});

describe("WeatherDashboard — auto-onboarding (Apple/Google Weather pattern)", () => {
  it("does not render WelcomeBanner (no forced personalization step)", () => {
    // Top-tier weather apps don't interrupt the first weather view with an
    // onboarding prompt — seeing your forecast IS the onboarding.
    expect(source).not.toContain("<WelcomeBanner");
    expect(source).not.toContain("@/components/weather/WelcomeBanner");
  });

  it("auto-completes onboarding via useEffect", () => {
    expect(source).toContain("hasOnboarded");
    expect(source).toContain("completeOnboarding");
  });

  it("reads hasOnboarded and completeOnboarding from store", () => {
    expect(source).toContain("s.hasOnboarded");
    expect(source).toContain("s.completeOnboarding");
  });

  it("does not auto-open modal for first-time visitors", () => {
    expect(source).not.toContain("setTimeout(openMyWeather");
  });
});

describe("WeatherDashboard — weather scene caching", () => {
  it("imports cacheWeatherHint from weather-scenes", () => {
    expect(source).toContain("cacheWeatherHint");
    expect(source).toContain("@/lib/weather-scenes");
  });

  it("calls cacheWeatherHint in a useEffect", () => {
    // cacheWeatherHint should be called inside a useEffect so the weather
    // hint is cached for the WeatherLoadingScene on next page load
    expect(source).toContain("cacheWeatherHint");
    expect(source).toContain("useEffect");
  });
});

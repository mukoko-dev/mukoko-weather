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
  it("does not duplicate /forecast's full HourlyForecast/DailyForecast/SunTimes charts", () => {
    // These sections used to render the exact same components /forecast
    // shows, verbatim, on the main page — contradicting the documented
    // "compact overview here, detail on sub-routes" philosophy. Full detail
    // now lives exclusively on /forecast; the main page keeps only the
    // always-present HourlyScrollCards preview + a link to /forecast.
    expect(source).not.toContain('label="hourly-forecast"');
    expect(source).not.toContain('label="daily-forecast"');
    expect(source).not.toContain('label="sun-times"');
    expect(source).not.toContain("<HourlyForecast");
    expect(source).not.toContain("<DailyForecast");
    expect(source).not.toContain("<SunTimes");
  });

  it("links the hourly scroll preview to the full /forecast sub-route", () => {
    expect(source).toContain("Full forecast →");
    expect(source).toContain("`/${location.slug}/forecast`");
  });

  it("renders ActivityInsights before AISummary", () => {
    const activityPos = source.indexOf('label="activity-insights"');
    const aiPos = source.indexOf('label="ai-summary"');
    expect(activityPos).toBeGreaterThan(-1);
    expect(aiPos).toBeGreaterThan(-1);
    expect(activityPos).toBeLessThan(aiPos);
  });

  it("renders AtmosphericSummary eagerly after CurrentConditions (not lazy)", () => {
    const currentPos = source.indexOf("<CurrentConditions");
    const atmosphericPos = source.indexOf("<AtmosphericSummary");
    expect(currentPos).toBeGreaterThan(-1);
    expect(atmosphericPos).toBeGreaterThan(-1);
    expect(currentPos).toBeLessThan(atmosphericPos);
    // AtmosphericSummary is no longer in a LazySection
    expect(source).not.toContain('label="atmospheric-summary"');
  });

  it("renders CurrentConditions eagerly (before any LazySection)", () => {
    const currentPos = source.indexOf("<CurrentConditions");
    const firstLazy = source.indexOf("<LazySection");
    expect(currentPos).toBeGreaterThan(-1);
    expect(firstLazy).toBeGreaterThan(-1);
    expect(currentPos).toBeLessThan(firstLazy);
  });

  it("sidebar starts with the weather map preview (SunTimes moved to /forecast only)", () => {
    const sidebarStart = source.indexOf("Sidebar");
    const mapPos = source.indexOf('label="weather-map"');
    expect(sidebarStart).toBeGreaterThan(-1);
    expect(mapPos).toBeGreaterThan(-1);
    expect(sidebarStart).toBeLessThan(mapPos);
  });
});

describe("WeatherDashboard — lazy loading", () => {
  const lazySections = [
    "ai-summary",
    "activity-insights",
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
    expect(source).toContain("AISummary");
    expect(source).toContain("MapPreview");
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

  it("wraps HourlyScrollCards in ChartErrorBoundary", () => {
    expect(source).toContain('name="hourly scroll cards"');
  });

  it("wraps AISummary in ChartErrorBoundary", () => {
    expect(source).toContain('name="AI summary"');
  });

  it("wraps all chart/data sections in ChartErrorBoundary", () => {
    const boundaryCount = (source.match(/<ChartErrorBoundary/g) || []).length;
    // Hourly scroll + Current + Atmospheric + Reports + Activities + AI
    // summary + AI chat + Map + Aviation + Support + Minutely + Models = 12
    expect(boundaryCount).toBeGreaterThanOrEqual(10);
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

describe("WeatherDashboard — welcome banner onboarding", () => {
  it("renders WelcomeBanner inline for first-time visitors", () => {
    // The banner itself gates on hasOnboarded (returns null once onboarded),
    // so mounting it unconditionally here is safe and lets first-time
    // visitors see it instead of silently skipping onboarding.
    expect(source).toContain("<WelcomeBanner");
    expect(source).toContain("@/components/weather/WelcomeBanner");
  });

  it("wires WelcomeBanner's personalise action to the My Weather modal", () => {
    expect(source).toContain("openMyWeather");
    expect(source).toContain("onChangeLocation={openMyWeather}");
  });

  it("passes the current location name to WelcomeBanner", () => {
    expect(source).toContain("locationName={location.name}");
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

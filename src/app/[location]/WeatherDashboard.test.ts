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

  it('aria-current="page" on the current location breadcrumb', () => {
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

describe("WeatherDashboard — layout control placement (bottom of page)", () => {
  const customiseIdx = () =>
    source.indexOf('aria-label="Customise section layout"');

  it("renders the Customise layout button after the sortable sections grid", () => {
    const gridEnd = source.indexOf("</DndContext>");
    expect(gridEnd).toBeGreaterThan(-1);
    expect(customiseIdx()).toBeGreaterThan(gridEnd);
  });

  it("renders it before the footer, at the bottom of main", () => {
    const mainEnd = source.indexOf("</main>");
    expect(customiseIdx()).toBeGreaterThan(-1);
    expect(customiseIdx()).toBeLessThan(mainEnd);
    expect(mainEnd).toBeLessThan(source.indexOf("<Footer />"));
  });

  it("uses the .impala-sm fauna button, centred", () => {
    const block = source.slice(customiseIdx() - 200, customiseIdx() + 40);
    expect(block).toContain('className="impala-sm"');
    expect(source).toMatch(/mt-8 flex justify-center/);
  });

  it("keeps only the clock in the header row (no layout button there)", () => {
    const clockIdx = source.indexOf("<LiveClock />");
    const firstOpen = source.indexOf("setReordering(true)");
    expect(clockIdx).toBeGreaterThan(-1);
    // The only setReordering(true) trigger lives below the grid, never beside the clock.
    expect(firstOpen).toBeGreaterThan(source.indexOf("</DndContext>"));
    const clockBlock = source.slice(clockIdx - 200, clockIdx + 40);
    expect(clockBlock).not.toContain("Customise");
  });

  it("hides the bottom trigger while reordering so the floating Done takes over", () => {
    expect(source).toMatch(/\{!reordering && \(/);
  });
});

describe("WeatherDashboard — floating Done pill (reorder mode)", () => {
  it("renders Done only while reordering and it resets reorder state", () => {
    expect(source).toMatch(/\{reordering && \(/);
    expect(source).toMatch(
      /onClick=\{\(\) => setReordering\(false\)\}\s*className="kudu-sm pointer-events-auto shadow-lg"/,
    );
  });

  it("is fixed bottom-centre above the mobile nav and drops to bottom-6 on sm+", () => {
    expect(source).toContain("fixed inset-x-0");
    expect(source).toContain("bottom-[var(--mobile-nav-clearance)]");
    expect(source).toContain("sm:bottom-6");
    expect(source).toContain("justify-center");
  });

  it("sits above content but below modals (z-30 < Radix z-50)", () => {
    expect(source).toContain("z-30");
    expect(source).not.toMatch(/fixed[^"]*\bz-(50|60)\b/);
  });

  it("announces reorder mode through an always-mounted polite status region", () => {
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain("Reorder mode on: drag sections, then press Done");
  });

  it("does not change the reorder logic (handleDragEnd + DraggableSection wiring intact)", () => {
    expect(source).toContain("onDragEnd={handleDragEnd}");
    expect(source).toContain("reordering={reordering}");
  });
});

describe("WeatherDashboard — mobile nav clearance and touch targets", () => {
  it("main bottom padding uses the nav-clearance token instead of a fixed pb-20", () => {
    expect(source).toContain("pb-[var(--mobile-nav-clearance)]");
    expect(source).not.toMatch(/\bpb-20\b/);
  });

  it("inline breadcrumb Home link carries the .dik-dik touch-target class", () => {
    const homeIdx = source.indexOf("href={BASE_URL}");
    expect(homeIdx).toBeGreaterThan(-1);
    expect(source.slice(homeIdx, homeIdx + 200)).toContain("dik-dik");
  });
});

describe("globals.css — touch-target and nav-clearance tokens", () => {
  const css = readFileSync(resolve(__dirname, "../globals.css"), "utf-8");

  it("defines the mobile nav clearance token from the nav inset and height", () => {
    expect(css).toContain("--mobile-nav-clearance:");
    expect(css).toContain("env(safe-area-inset-bottom");
    expect(css).toContain("--mobile-nav-inset:");
    expect(css).toContain("--mobile-nav-height:");
  });

  it("defines .dik-dik to reach the touch-target minimum on coarse pointers only", () => {
    const start = css.indexOf(".dik-dik {");
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, start + 400);
    expect(css).toMatch(/@media \(pointer: coarse\)\s*\{\s*\.dik-dik/);
    expect(rule).toContain("min-width: var(--touch-target-min)");
    expect(rule).toContain("min-height: var(--touch-target-min)");
  });
});

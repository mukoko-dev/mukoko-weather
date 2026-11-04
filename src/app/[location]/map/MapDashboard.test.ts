/**
 * Structural tests for the full-screen map dashboard. The page is a client
 * component that needs a browser, so these read the source: the layout, the
 * close link, the default layer, and the timeline wiring.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "MapDashboard.tsx"), "utf-8");
const loadingSource = readFileSync(resolve(__dirname, "loading.tsx"), "utf-8");

describe("MapDashboard — full-viewport layout", () => {
  it("fills the viewport with no site header (the close button replaces it)", () => {
    expect(source).toContain("h-[100dvh]");
    expect(source).not.toContain("<Header");
    expect(source).toContain('id="main-content"');
  });

  it("never puts the absolute fill on the MapLibre container (container-sizing rule)", () => {
    expect(source).not.toMatch(/ref=\{containerRef\}[^>]*absolute/);
  });

  it("hides the zoom buttons: the top-right stack owns that corner", () => {
    expect(source).toContain("navigationControl={false}");
  });
});

describe("MapDashboard — close and legend", () => {
  it("links the close button back to /{slug}", () => {
    expect(source).toContain("href={`/${location.slug}`}");
    expect(source).toContain("Close map and return to");
  });

  it("renders a legend labelled by its heading, with its unit, in the sheet", () => {
    expect(source).toContain('aria-labelledby="map-legend-title"');
    expect(source).toContain('id="map-legend-title"');
    expect(source).toContain("chip.legend.segments");
    expect(source).toContain("{chip.legend.unit}");
    expect(source).toMatch(/Legend, \{chip\.legend\.unit\}/);
    expect(source).toContain("chip?.legend.note");
  });
});

describe("MapDashboard — top-right controls", () => {
  it("has a layers toggle, a centre-on-my-location button and a list link", () => {
    expect(source).toContain("Hide map layers");
    expect(source).toContain("Centre the map on my location");
    expect(source).toContain('href="/locations"');
  });

  it("uses the shared geolocation helper with auto-create", () => {
    expect(source).toContain('from "@/lib/geolocation"');
    expect(source).toContain("detectUserLocation({ autoCreate: true })");
  });
});

describe("MapDashboard — layer state", () => {
  it("defaults to rain", () => {
    expect(source).toContain("DEFAULT_LAYER");
  });

  it("reads the remembered layer without a hydration mismatch", () => {
    expect(source).toContain("useSyncExternalStore");
    expect(source).toContain("readStoredMapLayer(getStorage(), chips)");
    expect(source).toContain("writeStoredMapLayer(getStorage(), id)");
  });

  it("guards localStorage access with try/catch (blocked storage throws)", () => {
    expect(source).toMatch(
      /function getStorage\(\)[\s\S]*?try \{[\s\S]*?catch/,
    );
  });
});

describe("MapDashboard — timeline", () => {
  it("only offers the scrubber for timeline-capable layers", () => {
    expect(source).toContain("layerSupportsTimeline(activeLayer)");
    expect(source).toContain("{timelineOn && (");
  });

  it("steps the overlay timestamp through the MapTimeline scrubber", () => {
    expect(source).toContain("forecastTimelineFrames(now)");
    expect(source).toContain("frames[step]?.timestamp");
    expect(source).toContain("<MapTimeline");
    expect(source).toContain("setStepChoice(next);");
    expect(source).toContain("onStepChange={(next) => {");
  });

  it("labels forward timelines in the place's time zone, not the viewer's", () => {
    expect(source).toContain("resolveUtcOffsetSeconds(");
    expect(source).toContain("location.country");
    // Exact from the fixed-offset table, else the API's DST-aware offset;
    // an estimate is flagged as approximate.
    expect(source).toContain("hasFixedUtcOffset(location.country)");
    expect(source).toContain("fetchPlaceOffset(location.lat, location.lon");
    expect(source).toContain("approximate: offsetApproximate");
    expect(source).not.toMatch(/getHours\(|toLocaleTimeString\(/);
  });

  it("keeps observed satellite loops on their own relative labels", () => {
    expect(source).toMatch(/gibsLayer\s*\?\s*null/);
    expect(source).toContain(
      'inputLabel={gibsLayer ? "Observation time" : "Forecast time"}',
    );
  });

  it("waits for hydration before showing clock-dependent labels", () => {
    expect(source).toContain("hydrated ? new Date(clock) : null");
  });

  it("stops playback when the sheet collapses (its pause button is hidden)", () => {
    expect(source).toContain(
      "const isPlaying = playing && timelineOn && sheetOpen;",
    );
  });
});

describe("MapDashboard — bottom sheet", () => {
  it("is a floating .serval card lifted off the edge by the safe area", () => {
    expect(source).toContain('data-slot="map-sheet"');
    // The same inset from the side and bottom edges as the controls above,
    // and the bar on other pages: the one float grid in globals.css.
    expect(source).toMatch(
      /serval absolute left-\[var\(--float-left\)\] right-\[var\(--float-right\)\] bottom-\[var\(--float-bottom\)\]/,
    );
    // Its height cap leaves room for the top controls and the grid's gaps, so
    // it never runs under them, with the safe area counted on both sides.
    expect(source).toContain(
      "max-h-[calc(100dvh-var(--float-top)-var(--touch-target-min)-var(--float-gap)-var(--float-bottom))]",
    );
    expect(source).toContain("max-w-xl");
  });

  it("collapses chips, model picker and timeline but always keeps the legend and credits", () => {
    expect(source).toContain("hidden={!sheetOpen}");
    expect(source).toMatch(
      /aria-label=\{\s*sheetOpen \? "Collapse map layers" : "Expand map layers"/,
    );
    // The credits sit outside the collapsible body.
    const body = source.indexOf("hidden={!sheetOpen}");
    expect(source.indexOf("<MapCredits", body)).toBeGreaterThan(
      source.indexOf("<MapTimeline", body),
    );
    expect(source).not.toContain("{sheetOpen && (");
  });

  it("caps its height so a landscape phone still sees the map", () => {
    // The cap is derived from the float grid (the top row of controls, a gap
    // and the safe areas), never a literal such as 6rem.
    expect(source).toMatch(/max-h-\[calc\(100dvh-var\(--float-top\)/);
    expect(source).not.toContain("100dvh-6rem");
    expect(source).toContain("overflow-y-auto");
    expect(source).toContain("[@media(max-height:500px)]:mr-auto");
  });

  it("clears playing on collapse so expanding does not restart it", () => {
    expect(source).toMatch(/const toggleSheet = [\s\S]*?setPlaying\(false\)/);
    expect(source).not.toContain("onClick={() => setSheetOpen");
  });

  it("does not leave the locate button stuck when GPS resolves to this place", () => {
    expect(source).toContain("result.location.slug === location.slug");
  });

  it("isolates the chips and the timeline in their own error boundaries", () => {
    expect(source).toContain('<ChartErrorBoundary name="map layers">');
    expect(source).toContain('<ChartErrorBoundary name="timeline">');
  });

  it("announces layer changes through the Mzizi harness", () => {
    expect(source).toContain('useMziziHarness("map-dashboard")');
    expect(source).toContain(
      "announce(`${next.label} layer, ${next.legend.unit}`)",
    );
  });

  it("uses one icon size for every control, and keeps top controls clear of the notch", () => {
    expect(source).toContain('const ICON_CLASS = "h-5 w-5";');
    expect(source).not.toMatch(/className="h-5 w-5"/);
    expect(source).toContain("top-[var(--float-top)]");
    expect(source).not.toContain("env(safe-area-inset-top)");
  });
});

describe("MapDashboard — timeline load speed (#266)", () => {
  it("preloads the next frame only once the timeline is used", () => {
    expect(source).toContain("timelineOn && timelineEngaged");
    expect(source).toContain("frames[(step + 1) % frameCount]?.timestamp");
    expect(source).toContain("weatherPrefetchTimestamp={prefetchTimestamp}");
    expect(source).toContain("setTimelineEngaged(true);");
  });

  it("waits for each frame to load before advancing playback", () => {
    expect(source).toContain("onWeatherFrameLoaded={setLoadedTimestamp}");
    expect(source).toContain("loadedTimestamp === weatherTimestamp");
    // Model fields and air quality draw no raster frame, so never wait on one.
    expect(source).toContain("!rasterOverlay ||");
    expect(source).toContain(
      "frameReady ? TIMELINE_TICK_MS : TIMELINE_MAX_WAIT_MS",
    );
    expect(source).not.toContain(
      "window.setInterval(\n      () =>\n        setStepChoice",
    );
  });

  it("starts the MapLibre download before hydration, in the browser only", () => {
    expect(source).toContain('if (typeof window !== "undefined") {');
    expect(source).toContain('import("maplibre-gl").catch(');
  });

  it("preconnects to MapTiler from the server page", () => {
    const page = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
    expect(page).toContain('import { preconnect } from "react-dom";');
    expect(page).toContain(
      'preconnect("https://api.maptiler.com", { crossOrigin: "anonymous" });',
    );
  });
});

describe("MapDashboard — air quality", () => {
  it("fetches the grid and feeds both the smooth picture and the bubbles", () => {
    expect(source).toContain("fetchAirQualityGrid");
    // The same 7 x 7 samples: interpolated for the picture, one bubble each.
    expect(source).toContain("aqFieldRaster(grid)");
    expect(source).toContain("aqiOverlay={aqOn ? aqRaster : null}");
    expect(source).toContain("aqiBubbles={aqOn ? bubbles : null}");
    expect(source).not.toContain("gridToGeoJSON");
  });

  it("never asks for more grid points to look smoother", () => {
    // Open-Meteo is rate limited and a grid miss already costs 49 locations:
    // the smoothness is interpolation in the browser, not a bigger request.
    expect(source).not.toMatch(/fetchAirQualityGrid\(\{[^}]*\b(n|radiusKm):/);
  });
});

describe("map loading skeleton", () => {
  it("is a full-viewport skeleton with no header or breadcrumb", () => {
    expect(loadingSource).toContain("MapSkeleton");
    expect(loadingSource).toContain("h-[100dvh]");
    expect(loadingSource).not.toContain("HeaderSkeleton");
    expect(loadingSource).not.toContain("BreadcrumbSkeleton");
  });
});

describe("MapDashboard — overlay sources and credits", () => {
  it("credits every source on screen from map-sources (one source of truth)", () => {
    expect(source).toContain("attributionForLayer(activeLayer, activeModel)");
    expect(source).toContain("<MapCredits credits={credits}");
    // Credits sit outside the collapsible body, so they are never hidden.
    expect(source).toContain(
      '<MapCredits credits={credits} className="text-center" />',
    );
    // No hand-written MapTiler line left behind.
    expect(source).not.toContain('href="https://www.maptiler.com/"');
  });

  it("looks up the GIBS frames that exist before animating satellite imagery", () => {
    expect(source).toContain(
      "fetchGibsDomains(gibsLayer, new Date(), controller.signal)",
    );
    expect(source).toContain("satelliteFrames(gibsLayer, intervals, now)");
  });

  it("keeps model fields behind their flag and opens the picker on the preference", () => {
    expect(source).toContain('getFeatureFlag("model_map_layers")');
    expect(source).toContain("mapModelForPreference(preferredModel)");
    // Read-only: comparing models on the map never switches the dashboard baseline.
    expect(source).not.toContain("setSelectedForecastModel");
    expect(source).toContain("const current = s ?? defaultStep;");
    expect(source).toContain(
      "modelGridData?.times.indexOf(frames[step]?.timestamp",
    );
    expect(source).toContain("fieldOverlay={fieldOverlay}");
  });

  it("paints a model step as one interpolated picture of the same grid", () => {
    expect(source).toContain(
      "modelFieldRaster(modelGridData, activeLayer, seriesIndex)",
    );
    expect(source).not.toContain("modelGridToGeoJSON");
    expect(source).toContain("fetchModelGrid({");
  });
});

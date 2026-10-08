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

describe("MapDashboard — top-left close and legend", () => {
  it("links the close button back to /{slug}", () => {
    expect(source).toContain("href={`/${location.slug}`}");
    expect(source).toContain("Close map and return to");
  });

  it("renders a legend labelled by its heading", () => {
    expect(source).toContain('aria-labelledby="map-legend-title"');
    expect(source).toContain('id="map-legend-title"');
    expect(source).toContain("chip.legend.segments");
  });
});

describe("MapDashboard — top-right controls", () => {
  it("has a layers toggle, a centre-on-my-location button and a list link", () => {
    expect(source).toContain("Hide layer panel");
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
    expect(source).toContain("readStoredMapLayer(getStorage())");
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

  it("steps the overlay timestamp and has a play/pause control", () => {
    expect(source).toContain("timelineTimestamp(step, new Date())");
    expect(source).toContain("aria-label={");
    expect(source).toContain("Play forecast timeline");
    expect(source).toContain("Pause forecast timeline");
  });
});

describe("MapDashboard — air quality", () => {
  it("fetches the grid and feeds both the fill and the bubbles", () => {
    expect(source).toContain("fetchAirQualityGrid");
    expect(source).toContain("aqiOverlay={aqOn ? aqFill : null}");
    expect(source).toContain("aqiBubbles={aqOn ? bubbles : null}");
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

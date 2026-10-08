import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Node-env structural checks (no DOM renderer) — read the component source.
const source = readFileSync(
  resolve(__dirname, "AirQualityMapCard.tsx"),
  "utf-8",
);

describe("AirQualityMapCard structure", () => {
  it("is a client component that lazy-loads MapLibre with SSR disabled", () => {
    expect(source.startsWith('"use client"')).toBe(true);
    expect(source).toContain("dynamic(");
    expect(source).toContain("ssr: false");
    expect(source).toContain('import("./map/MapLibreMap")');
  });

  it("renders the AIR QUALITY MAP eyebrow as a labelled section", () => {
    expect(source).toContain("AIR QUALITY MAP");
    expect(source).toContain("aria-labelledby={headingId}");
    expect(source).toContain("useId()");
  });

  it("uses a non-interactive map with the AQI overlay", () => {
    expect(source).toContain("interactive={false}");
    expect(source).toContain("aqiOverlay={overlay}");
    expect(source).toContain("gridToGeoJSON(");
  });

  it("shows a centred '{aqi} · My Location' bubble, hidden from AT", () => {
    expect(source).toContain("· My Location");
    expect(source).toMatch(/aria-hidden="true"[\s\S]*?· My Location/);
  });

  it("is a square card capped in height so it reads as a large card", () => {
    expect(source).toContain("aspect-square max-h-[28rem]");
  });

  it("shows a skeleton with role=status and aria-label=Loading while fetching", () => {
    expect(source).toContain('role="status"');
    expect(source).toContain('aria-label="Loading"');
    expect(source).toContain("chameleon aspect-square max-h-[28rem]");
  });

  it("renders nothing when the grid is unavailable", () => {
    expect(source).toContain(
      'if (state.status === "unavailable") return null;',
    );
    expect(source).toContain("if (!data.available || aqi === null");
  });

  it("gives the map an accessible summary with the band, value and place", () => {
    expect(source).toContain('role="img"');
    expect(source).toContain(
      "`Air quality around ${placeName}: ${AQI_BAND_LABELS[band].toLowerCase()} (${aqi}) at your location`",
    );
  });

  it("uses literal severity text classes per band (no dynamic class names)", () => {
    for (const cls of [
      "text-severity-low",
      "text-severity-moderate",
      "text-severity-high",
      "text-severity-severe",
      "text-severity-extreme",
    ]) {
      expect(source).toContain(cls);
    }
  });

  it("contains no hardcoded hex colours, rgba() or inline styles", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(/);
    expect(source).not.toContain("style={{");
  });

  it("fetches via the shared aq-grid helper with the 7×7 / 40 km grid", () => {
    expect(source).toContain("fetchAirQualityGrid({");
    expect(source).toContain("const GRID_RADIUS_KM = 40;");
    expect(source).toContain("const GRID_N = 7;");
    expect(source).toContain("controller.abort()");
  });
});

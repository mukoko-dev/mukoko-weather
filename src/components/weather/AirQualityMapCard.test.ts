/**
 * AirQualityMapCard (#476): the card is a raster picture with the AQI grid
 * drawn over it as SVG, not a MapLibre map. The view is rendered for real
 * (react-dom/server) so the checks are on the HTML a visitor gets; the few
 * structural checks read the source for what no render can show (that the
 * map library is not imported at all).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { resolve } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AqGridResponse } from "@/lib/aq-grid";

const theme = vi.hoisted(() => ({ dark: false }));
vi.mock("./map/use-map-style", () => ({ useMapIsDark: () => theme.dark }));

const raw = readFileSync(resolve(__dirname, "AirQualityMapCard.tsx"), "utf-8");
// The code, without its comments (which name MapLibre and issue numbers).
const source = raw
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/** The 7x7 grid the Worker sends by default: 11 km cells around Harare. */
function grid(): AqGridResponse {
  const points = [];
  for (let i = -3; i <= 3; i++)
    for (let j = -3; j <= 3; j++)
      points.push({
        lat: -17.83 + i * 0.1,
        lon: 31.05 + j * 0.1,
        aqi: 20 + ((i * j + 9) % 30) * 8,
        pm2_5: 10,
      });
  return {
    available: true,
    center: { lat: -17.83, lon: 31.05, aqi: 52 },
    cellKm: 11,
    points,
    fetchedAt: "2026-11-04T12:00:00Z",
    source: "CAMS",
  };
}

async function render(opts: { key?: string; dark?: boolean } = {}) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_MAPTILER_API_KEY", opts.key ?? "test-key\n");
  theme.dark = opts.dark ?? false;
  const { AirQualityMapView } = await import("./AirQualityMapCard");
  const { attributionForLayer } = await import("@/lib/map-sources");
  return {
    html: renderToStaticMarkup(
      createElement(AirQualityMapView, {
        lat: -17.83,
        lon: 31.05,
        placeName: "Harare",
        data: grid(),
        aqi: 52,
        band: "moderate",
      }),
    ),
    credits: attributionForLayer("airQuality"),
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("AirQualityMapCard is not a MapLibre map", () => {
  it("imports no map library, no dynamic chunk and no WebGL map component", () => {
    expect(source).not.toMatch(/maplibre/i);
    expect(source).not.toContain("MapLibreMap");
    expect(source).not.toContain("dynamic(");
    expect(source).not.toContain("interactive={false}");
  });

  it("is a client component (it fetches the grid after mount)", () => {
    expect(source.startsWith('"use client"')).toBe(true);
  });

  it("contains no hardcoded hex colours, rgba() or inline styles", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toMatch(/rgba?\(/);
    expect(source).not.toContain("style={{");
  });

  it("fetches via the shared aq-grid helper with the 7x7 / 40 km grid, aborting on unmount", () => {
    expect(source).toContain("fetchAirQualityGrid({");
    expect(source).toContain("const GRID_RADIUS_KM = 40;");
    expect(source).toContain("const GRID_N = 7;");
    expect(source).toContain("controller.abort()");
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
});

describe("AirQualityMapView", () => {
  it("draws four MapTiler raster tiles at zoom 9 with the trimmed key", async () => {
    const { html } = await render();
    const tiles = [...html.matchAll(/<image[^>]*href="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(tiles).toHaveLength(4);
    for (const href of tiles) {
      expect(href).toMatch(
        /^https:\/\/api\.maptiler\.com\/maps\/streets-v2\/9\/\d+\/\d+\.png\?key=test-key$/,
      );
    }
  });

  it("follows the theme", async () => {
    const { html } = await render({ dark: true });
    expect(html).toContain("/maps/streets-v2-dark/9/");
  });

  it("draws one cell per grid point, in the EPA band's fill class, outlined", async () => {
    const { html } = await render();
    const polygons = [...html.matchAll(/<polygon[^>]*>/g)].map((m) => m[0]);
    expect(polygons).toHaveLength(49);
    for (const polygon of polygons) {
      expect(polygon).toMatch(/fill-wx-aqi-[1-6]/);
      expect(polygon).toContain("stroke-wx-outline");
      expect(polygon).toContain('fill-opacity="0.55"');
      // The outline stays one pixel however the picture is scaled.
      expect(polygon).toContain('vector-effect="non-scaling-stroke"');
    }
    const used = new Set(
      polygons.map((p) => /fill-wx-aqi-([1-6])/.exec(p)![1]),
    );
    expect(used.size).toBeGreaterThan(2);
  });

  it("keeps the centre bubble with the band's fill and a printed number", async () => {
    const { html } = await render();
    expect(html).toContain("· My Location");
    expect(html).toContain("bg-wx-aqi-2");
    expect(html).toMatch(/>52</);
  });

  it("gives the picture an accessible summary and hides its parts from AT", async () => {
    const { html } = await render();
    expect(html).toContain(
      'aria-label="Air quality around Harare: moderate (52) at your location"',
    );
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toMatch(/<h2[^>]*>Air Quality Map<\/h2>/);
    expect(html).toContain("aria-labelledby=");
  });

  it("credits the base map and the air quality data, from map-sources, outside the picture", async () => {
    const { html, credits } = await render();
    expect(credits.map((c) => c.id)).toEqual([
      "maptiler",
      "osm",
      "cams",
      "open-meteo",
    ]);
    for (const p of credits) expect(html).toContain(`href="${p.href}"`);
    // The credits are links, so they cannot sit inside role="img".
    const picture = html.slice(
      html.indexOf('role="img"'),
      html.indexOf("Map and data sources"),
    );
    expect(picture).not.toContain("<a ");
  });

  it("is a square card capped in height so it reads as a large card", async () => {
    const { html } = await render();
    expect(html).toContain("aspect-square max-h-[28rem]");
  });

  it("still draws the cells when there is no MapTiler key (no tiles, no map library)", async () => {
    const { html } = await render({ key: "" });
    expect(html).not.toContain("<image");
    expect(html.match(/<polygon/g)).toHaveLength(49);
  });

  it("ships no map library markup", async () => {
    const { html } = await render();
    expect(html).not.toMatch(/maplibre|<canvas/i);
  });
});

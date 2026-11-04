/**
 * AirQualityMapCard (#476): the card is a raster picture with the same smooth
 * banded image the full map shows drawn over it as SVG (one square per grid
 * point where that cannot be painted), not a MapLibre map. The view is rendered
 * for real (react-dom/server) so the checks are on the HTML a visitor gets; the
 * few structural checks read the source for what no render can show (that the
 * map library is not imported at all). The canvas that paints the picture does
 * not exist in Node, so `field-raster-image` is replaced by a stand-in whose
 * data URL the tests choose (null: no canvas).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { resolve } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aqFieldRaster, type AqGridResponse } from "@/lib/aq-grid";
import { contourLines } from "@/lib/field-raster";
import { worldRect } from "@/lib/static-map";

const theme = vi.hoisted(() => ({ dark: false }));
vi.mock("./map/use-map-style", () => ({ useMapIsDark: () => theme.dark }));
const picture = vi.hoisted(() => ({ url: null as string | null }));
vi.mock("@/lib/field-raster-image", () => ({
  rasterPalette: () => [],
  rasterDataUrl: () => picture.url,
}));

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

const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

async function render(
  opts: { key?: string; dark?: boolean; url?: string | null } = {},
) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_MAPTILER_API_KEY", opts.key ?? "test-key\n");
  theme.dark = opts.dark ?? false;
  picture.url = opts.url ?? null;
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

  it("falls back to one cell per grid point, in the EPA band's fill class, outlined, where the picture cannot be painted", async () => {
    const { html } = await render({ url: null });
    expect(html).not.toContain("data:image");
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

  it("draws the smooth banded picture the full map shows: one <image> over the tiles, 0.55 opaque, stretched to the raster's rectangle", async () => {
    const { html } = await render({ url: DATA_URL });
    const raster = aqFieldRaster(grid())!;
    const rect = worldRect(raster.extent, 9);
    const images = [...html.matchAll(/<image[^>]*>/g)].map((m) => m[0]);
    const data = images.filter((tag) => tag.includes(DATA_URL));
    expect(images).toHaveLength(5); // four tiles and the picture
    expect(data).toHaveLength(1);
    expect(data[0]).toContain('preserveAspectRatio="none"');
    expect(data[0]).toContain('opacity="0.55"');
    // Placed with the static map's own projection: north and south projected.
    const attr = (name: string) =>
      Number(new RegExp(` ${name}="([^"]+)"`).exec(data[0])![1]);
    expect(attr("x")).toBeCloseTo(rect.x, 6);
    expect(attr("y")).toBeCloseTo(rect.y, 6);
    expect(attr("width")).toBeCloseTo(rect.width, 6);
    expect(attr("height")).toBeCloseTo(rect.height, 6);
    // The tiles are drawn first, the picture on top of them.
    expect(html.indexOf(DATA_URL)).toBeGreaterThan(
      html.indexOf("api.maptiler.com"),
    );
    expect(html).not.toContain("<polygon");
  });

  it("outlines the band edges with thin vector paths, one per level the field crosses", async () => {
    const { html } = await render({ url: DATA_URL });
    const levels = contourLines(aqFieldRaster(grid())!).features.length;
    const paths = [...html.matchAll(/<path[^>]*>/g)].map((m) => m[0]);
    expect(levels).toBeGreaterThan(0);
    expect(paths).toHaveLength(levels);
    for (const path of paths) {
      expect(path).toContain("stroke-wx-outline");
      expect(path).toContain('fill="none"');
      expect(path).toContain('vector-effect="non-scaling-stroke"');
      expect(path).toContain('stroke-linecap="round"');
      expect(path).toMatch(/ d="M[\d.\-]+ [\d.\-]+L/);
    }
  });

  it("keeps the opacity of the full map's air quality layer", () => {
    const map = readFileSync(
      resolve(__dirname, "map/MapLibreMap.tsx"),
      "utf-8",
    );
    const live = /const AQI_OVERLAY_OPACITY = ([\d.]+);/.exec(map)![1];
    expect(raw).toContain(`export const AQI_FIELD_OPACITY = ${live};`);
  });

  it("paints the raster once per grid, from the same aqFieldRaster the full map uses", () => {
    expect(source).toContain("aqFieldRaster(data)");
    expect(source).not.toContain("gridToGeoJSON");
    expect(source).toContain("rasterDataUrl(raster, rasterPalette(raster))");
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

  it("with no MapTiler key shows the reading and a text fallback, not bare squares, and credits no base map", async () => {
    const { html } = await render({ key: "" });
    expect(html).not.toContain("<image");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<polygon");
    expect(html).toContain("The map could not be loaded");
    // The reading itself is still there, in its band's colour and for AT.
    expect(html).toContain("· My Location");
    expect(html).toContain("bg-wx-aqi-2");
    expect(html).toContain(
      'aria-label="Air quality around Harare: moderate (52) at your location"',
    );
    // MapTiler and OpenStreetMap are credited only when their map is drawn.
    expect(html).not.toMatch(/MapTiler|OpenStreetMap/);
    expect(html).toContain("Copernicus Atmosphere Monitoring Service");
    expect(html).toContain("Open-Meteo.com");
  });

  it("draws no fallback text when the tiles are shown", async () => {
    const { html } = await render();
    expect(html).not.toContain("The map could not be loaded");
  });

  it("ships no map library markup", async () => {
    const { html } = await render();
    expect(html).not.toMatch(/maplibre|<canvas/i);
  });
});

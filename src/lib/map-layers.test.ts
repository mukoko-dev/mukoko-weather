import { describe, it, expect } from "vitest";
import {
  MAP_LAYERS,
  DEFAULT_LAYER,
  getMapLayerById,
  MAPTILER_STYLE_LIGHT,
  MAPTILER_STYLE_DARK,
  WEATHER_OVERLAY_ID,
  WEATHER_OVERLAY_MIN_ZOOM,
  WEATHER_OVERLAY_MAX_ZOOM,
  weatherOverlayTileUrl,
  buildWeatherOverlaySource,
} from "./map-layers";

describe("MAP_LAYERS", () => {
  it("has at least 3 layers (issue requirement)", () => {
    expect(MAP_LAYERS.length).toBeGreaterThanOrEqual(3);
  });

  it("each layer has required fields", () => {
    for (const layer of MAP_LAYERS) {
      expect(layer.id).toBeTruthy();
      expect(layer.label).toBeTruthy();
      expect(layer.description).toBeTruthy();
      expect(layer.icon).toBeTruthy();
      expect(layer.style).toBeDefined();
      expect(layer.style.bg).toBeTruthy();
      expect(layer.style.border).toBeTruthy();
      expect(layer.style.text).toBeTruthy();
      expect(layer.style.badge).toBeTruthy();
    }
  });

  it("has unique layer IDs", () => {
    const ids = MAP_LAYERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes precipitationIntensity layer", () => {
    expect(MAP_LAYERS.some((l) => l.id === "precipitationIntensity")).toBe(true);
  });

  it("includes cloudCover layer", () => {
    expect(MAP_LAYERS.some((l) => l.id === "cloudCover")).toBe(true);
  });

  it("includes temperature layer", () => {
    expect(MAP_LAYERS.some((l) => l.id === "temperature")).toBe(true);
  });
});

describe("DEFAULT_LAYER", () => {
  it("is a valid layer ID", () => {
    expect(MAP_LAYERS.some((l) => l.id === DEFAULT_LAYER)).toBe(true);
  });

  it("defaults to a reliably-rendering (non-time-indexed) overlay, not precipitation", () => {
    // Precipitation radar tiles can 400 without a valid recent timestamp, so the
    // map opens on cloud cover to avoid an error banner on first paint.
    expect(DEFAULT_LAYER).toBe("cloudCover");
  });
});

describe("getMapLayerById", () => {
  it("returns the layer for a valid ID", () => {
    const layer = getMapLayerById("precipitationIntensity");
    expect(layer).toBeDefined();
    expect(layer!.label).toBe("Rain");
  });

  it("returns undefined for an invalid ID", () => {
    expect(getMapLayerById("nonexistent")).toBeUndefined();
  });
});

describe("weatherOverlayTileUrl", () => {
  it("targets the server-side proxy (keeps the Tomorrow.io key server-side)", () => {
    const url = weatherOverlayTileUrl("precipitationIntensity");
    expect(url.startsWith("/api/py/map-tiles?")).toBe(true);
    expect(url).not.toContain("api.tomorrow.io");
    expect(url).not.toContain("apikey");
  });

  it("includes MapLibre {z}/{x}/{y} placeholders and the layer id", () => {
    const url = weatherOverlayTileUrl("windSpeed");
    expect(url).toContain("z={z}");
    expect(url).toContain("x={x}");
    expect(url).toContain("y={y}");
    expect(url).toContain("layer=windSpeed");
  });

  it("URL-encodes the layer id", () => {
    // Placeholders must survive encoding; the layer value is encoded.
    const url = weatherOverlayTileUrl("temp erature");
    expect(url).toContain("layer=temp%20erature");
    expect(url).toContain("{z}");
  });

  it("builds valid URLs for every configured layer", () => {
    for (const layer of MAP_LAYERS) {
      expect(weatherOverlayTileUrl(layer.id)).toContain(`layer=${layer.id}`);
    }
  });
});

describe("buildWeatherOverlaySource", () => {
  it("is a 256px raster source pinned to the Tomorrow.io zoom range (1–12)", () => {
    const src = buildWeatherOverlaySource("cloudCover");
    expect(src.type).toBe("raster");
    expect(src.tileSize).toBe(256);
    // Pinning maxzoom to 12 makes MapLibre overzoom instead of requesting
    // z13+ tiles the proxy rejects (which would make the overlay vanish).
    expect(src.minzoom).toBe(WEATHER_OVERLAY_MIN_ZOOM);
    expect(src.maxzoom).toBe(WEATHER_OVERLAY_MAX_ZOOM);
    expect(WEATHER_OVERLAY_MIN_ZOOM).toBe(1);
    expect(WEATHER_OVERLAY_MAX_ZOOM).toBe(12);
  });

  it("uses the proxied tile URL for the requested layer", () => {
    const src = buildWeatherOverlaySource("temperature");
    expect(src.tiles).toEqual([weatherOverlayTileUrl("temperature")]);
  });
});

describe("WEATHER_OVERLAY_ID", () => {
  it("is a stable, non-empty id shared by source and layer", () => {
    expect(WEATHER_OVERLAY_ID).toBe("weather-overlay");
  });
});

describe("MapTiler style URLs", () => {
  it("MAPTILER_STYLE_LIGHT points to streets-v2", () => {
    expect(MAPTILER_STYLE_LIGHT).toContain("streets-v2/style.json");
    expect(MAPTILER_STYLE_LIGHT).toContain("maptiler.com");
  });

  it("MAPTILER_STYLE_DARK points to streets-v2-dark", () => {
    expect(MAPTILER_STYLE_DARK).toContain("streets-v2-dark/style.json");
    expect(MAPTILER_STYLE_DARK).toContain("maptiler.com");
  });

  it("light and dark styles are different URLs", () => {
    expect(MAPTILER_STYLE_LIGHT).not.toBe(MAPTILER_STYLE_DARK);
  });
});

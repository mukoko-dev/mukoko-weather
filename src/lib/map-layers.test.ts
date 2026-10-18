import { afterEach, describe, it, expect, vi } from "vitest";
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
  AIR_QUALITY_LAYER_ID,
  MAP_CHIPS,
  getMapChip,
  layerSupportsTimeline,
  timelineTimestamp,
  timelineLabel,
  TIMELINE_STEPS,
  MAP_LAYER_STORAGE_KEY,
  readStoredMapLayer,
  writeStoredMapLayer,
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
    expect(MAP_LAYERS.some((l) => l.id === "precipitationIntensity")).toBe(
      true,
    );
  });

  it("includes cloudCover layer", () => {
    expect(MAP_LAYERS.some((l) => l.id === "cloudCover")).toBe(true);
  });

  it("includes temperature layer", () => {
    expect(MAP_LAYERS.some((l) => l.id === "temperature")).toBe(true);
  });

  it("gives EVERY layer a non-empty icon name (switcher must never be iconless)", () => {
    for (const layer of MAP_LAYERS) {
      expect(typeof layer.icon).toBe("string");
      expect(layer.icon.length).toBeGreaterThan(0);
    }
  });

  it("gives the cloud layer a Cloud icon (was previously missing in the switcher)", () => {
    const cloud = MAP_LAYERS.find((l) => l.id === "cloudCover");
    expect(cloud).toBeDefined();
    expect(cloud!.icon).toBe("Cloud");
  });
});

describe("DEFAULT_LAYER", () => {
  it("is a valid layer ID", () => {
    expect(MAP_LAYERS.some((l) => l.id === DEFAULT_LAYER)).toBe(true);
  });

  it("defaults to rain (the design brief: the map opens on precipitation)", () => {
    expect(DEFAULT_LAYER).toBe("precipitationIntensity");
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
    expect(
      url.startsWith("https://weather-tiles.mukoko.com/v1/map-tiles?"),
    ).toBe(true);
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

  it("adds an hourly timestamp only when one is given (now stays implicit)", () => {
    expect(weatherOverlayTileUrl("precipitationIntensity")).not.toContain(
      "timestamp=",
    );
    expect(
      weatherOverlayTileUrl("precipitationIntensity", "now"),
    ).not.toContain("timestamp=");
    const url = weatherOverlayTileUrl(
      "precipitationIntensity",
      "2026-10-08T06:00:00Z",
    );
    expect(url).toContain("timestamp=2026-10-08T06%3A00%3A00Z");
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

describe("map chips (full-screen map)", () => {
  it("lists air quality, the four tile layers and the two NASA satellite layers, each with a label and a legend", () => {
    expect(MAP_CHIPS.map((c) => c.id)).toEqual([
      AIR_QUALITY_LAYER_ID,
      "precipitationIntensity",
      "temperature",
      "windSpeed",
      "cloudCover",
      "satellite",
      "satelliteRain",
    ]);
    for (const chip of MAP_CHIPS) {
      expect(chip.label).toBeTruthy();
      expect(chip.legend.unit).toBeTruthy();
      // Imagery without a value scale explains itself with a note instead.
      if (chip.legend.segments.length === 0) {
        expect(chip.legend.note).toBeTruthy();
      } else {
        expect(chip.legend.segments.length).toBeGreaterThan(1);
      }
    }
  });

  it("gives each legend segment a static Tailwind class, never a raw colour", () => {
    for (const chip of MAP_CHIPS) {
      for (const seg of chip.legend.segments) {
        expect(seg.className).toMatch(/^bg-/);
        expect(seg.className).not.toMatch(/#|rgb/);
      }
    }
  });

  it("uses US AQI units for air quality and the brief's units for the rest", () => {
    expect(getMapChip(AIR_QUALITY_LAYER_ID)!.legend.unit).toBe("US AQI");
    expect(getMapChip("precipitationIntensity")!.legend.unit).toBe("mm/h");
    expect(getMapChip("temperature")!.legend.unit).toBe("°C");
    expect(getMapChip("windSpeed")!.legend.unit).toBe("km/h");
    expect(getMapChip("cloudCover")!.legend.unit).toBe("%");
  });

  it("returns undefined for unknown chip ids", () => {
    expect(getMapChip("humidity")).toBeUndefined();
  });
});

describe("timeline (forecast scrubber)", () => {
  it("offers the scrubber for rain only (other layers are not verified for forecast timestamps)", () => {
    expect(layerSupportsTimeline("precipitationIntensity")).toBe(true);
    expect(layerSupportsTimeline("temperature")).toBe(false);
    expect(layerSupportsTimeline("windSpeed")).toBe(false);
    expect(layerSupportsTimeline("cloudCover")).toBe(false);
    expect(layerSupportsTimeline(AIR_QUALITY_LAYER_ID)).toBe(false);
  });

  it("runs from Now to +3 days in 3-hour stops (25 stops)", () => {
    expect(TIMELINE_STEPS).toBe(25);
    expect(timelineLabel(0)).toBe("Now");
    expect(timelineLabel(1)).toBe("+3h");
    expect(timelineLabel(8)).toBe("+1d");
    expect(timelineLabel(TIMELINE_STEPS - 1)).toBe("+3d");
  });

  it("step 0 is the live tile; later steps are hour-aligned ISO timestamps the proxy accepts", () => {
    const now = new Date("2026-10-08T06:41:12Z");
    expect(timelineTimestamp(0, now)).toBe("now");
    const t3 = timelineTimestamp(1, now);
    expect(t3).toBe("2026-10-08T09:00:00Z");
    expect(t3).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(timelineTimestamp(TIMELINE_STEPS - 1, now)).toBe(
      "2026-10-11T06:00:00Z",
    );
  });

  it("does not mutate the Date it is given", () => {
    const now = new Date("2026-10-08T06:41:12Z");
    timelineTimestamp(4, now);
    expect(now.toISOString()).toBe("2026-10-08T06:41:12.000Z");
  });
});

describe("remembered map layer (localStorage)", () => {
  function memory(initial: Record<string, string> = {}) {
    const store = { ...initial };
    return {
      store,
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    };
  }

  it("round-trips a chosen layer under a stable key", () => {
    const m = memory();
    writeStoredMapLayer(m, "temperature");
    expect(m.store[MAP_LAYER_STORAGE_KEY]).toBe("temperature");
    expect(readStoredMapLayer(m)).toBe("temperature");
  });

  it("ignores unknown or missing values", () => {
    expect(readStoredMapLayer(memory())).toBeNull();
    expect(
      readStoredMapLayer(memory({ [MAP_LAYER_STORAGE_KEY]: "nope" })),
    ).toBeNull();
  });

  it("returns null when storage is missing or throws (private windows, blocked storage)", () => {
    expect(readStoredMapLayer(null)).toBeNull();
    expect(readStoredMapLayer(undefined)).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readStoredMapLayer(throwing)).toBeNull();
  });

  it("never throws when writing to blocked storage", () => {
    const throwing = {
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() => writeStoredMapLayer(throwing, "windSpeed")).not.toThrow();
    expect(() => writeStoredMapLayer(null, "windSpeed")).not.toThrow();
  });
});

describe("map overlay sources (satellite, model fields, timeline)", () => {
  it("builds GIBS sources for satellite chips and Tomorrow.io sources otherwise", async () => {
    const { buildWeatherOverlaySource, weatherOverlayOpacity } =
      await import("./map-layers");
    const sat = buildWeatherOverlaySource("satellite", "2026-10-10");
    expect(sat.tiles[0]).toContain("gibs.earthdata.nasa.gov");
    expect(sat.tiles[0]).toContain("/2026-10-10/");
    expect(sat.maxzoom).toBe(9);
    expect(sat.attribution).toContain("NASA GIBS");
    // "now" resolves to the newest frame by fixed latency (never a future 404).
    const satNow = buildWeatherOverlaySource("satelliteRain", "now");
    expect(satNow.tiles[0]).toMatch(
      /\/\d{4}-\d{2}-\d{2}T\d{2}%3A\d{2}%3A00Z\//,
    );
    const rain = buildWeatherOverlaySource("precipitationIntensity");
    expect(rain.tiles[0]).toContain(
      "https://weather-tiles.mukoko.com/v1/map-tiles",
    );
    expect(rain.attribution).toContain("Tomorrow.io");
    expect(weatherOverlayOpacity("precipitationIntensity")).toBe(0.6);
    expect(weatherOverlayOpacity("satellite")).toBeGreaterThan(0.6);
  });

  it("keeps the model chips out of MAP_CHIPS until their flag is on", async () => {
    const { mapChipsFor, MODEL_CHIPS } = await import("./map-layers");
    expect(mapChipsFor({ modelLayers: false })).toBe(MAP_CHIPS);
    const withModels = mapChipsFor({ modelLayers: true }).map((c) => c.id);
    for (const chip of MODEL_CHIPS) {
      expect(MAP_CHIPS.some((c) => c.id === chip.id)).toBe(false);
      expect(withModels).toContain(chip.id);
    }
  });

  it("gives every model legend band a token and an ascending start value", async () => {
    const { MODEL_CHIPS } = await import("./map-layers");
    for (const chip of MODEL_CHIPS) {
      let last = -Infinity;
      for (const seg of chip.legend.segments) {
        expect(seg.token).toMatch(/^--color-/);
        // The class and the token must name the same colour.
        expect(seg.className).toBe(`bg-${seg.token!.replace("--color-", "")}`);
        expect(seg.from!).toBeGreaterThanOrEqual(last);
        last = seg.from!;
      }
    }
  });

  it("classifies values into legend bands", async () => {
    const { legendBandIndex, getMapChip: chip } = await import("./map-layers");
    const temp = chip("modelTemperature")!.legend;
    expect(legendBandIndex(temp, -5)).toBe(0);
    expect(legendBandIndex(temp, 10)).toBe(1);
    expect(legendBandIndex(temp, 40)).toBe(temp.segments.length - 1);
    expect(legendBandIndex(temp, null)).toBe(-1);
    expect(legendBandIndex(temp, Number.NaN)).toBe(-1);
    const rain = chip("modelPrecipitation")!.legend;
    expect(legendBandIndex(rain, 0)).toBe(-1);
    // Tomorrow.io legends have no numeric bands.
    expect(legendBandIndex(chip("precipitationIntensity")!.legend, 5)).toBe(-1);
  });

  it("offers the timeline for satellite and model layers too", () => {
    expect(layerSupportsTimeline("satellite")).toBe(true);
    expect(layerSupportsTimeline("satelliteRain")).toBe(true);
    expect(layerSupportsTimeline("modelWind")).toBe(true);
    expect(layerSupportsTimeline("cloudCover")).toBe(false);
  });

  it("builds forecast, model and default timeline frames", async () => {
    const m = await import("./map-layers");
    const forecast = m.forecastTimelineFrames(new Date("2026-10-11T07:20:00Z"));
    expect(forecast).toHaveLength(TIMELINE_STEPS);
    expect(forecast[0]).toEqual({ timestamp: "now", label: "Now" });
    expect(forecast[1].timestamp).toBe("2026-10-11T10:00:00Z");
    const times = [
      "2026-10-11T06:00Z",
      "2026-10-11T09:00Z",
      "2026-10-11T12:00Z",
    ];
    const model = m.modelTimelineFrames(
      times,
      new Date("2026-10-11T06:20:00Z"),
    );
    expect(model.map((f) => f.label)).toEqual(["Now", "+3h", "+6h"]);
    // A grid cached 3 h ago: past steps drop, labels count from now.
    const stale = m.modelTimelineFrames(
      times,
      new Date("2026-10-11T09:50:00Z"),
    );
    expect(stale.map((f) => f.timestamp)).toEqual(times.slice(1));
    expect(stale.map((f) => f.label)).toEqual(["Now", "+2h"]);
    expect(m.modelTimelineFrames(["junk"], new Date())).toEqual([]);
    expect(m.timelineDefaultIndex("satellite", model)).toBe(2);
    expect(m.timelineDefaultIndex("modelWind", model)).toBe(0);
    expect(m.timelineDefaultIndex("satellite", [])).toBe(0);
  });

  it("spreads axis labels evenly, keeping the ends", async () => {
    const m = await import("./map-layers");
    const frames = m.forecastTimelineFrames(new Date("2026-10-11T07:00:00Z"));
    expect(m.timelineAxisLabels(frames)).toEqual(["Now", "+1d", "+2d", "+3d"]);
    expect(m.timelineAxisLabels(frames.slice(0, 2))).toEqual(["Now", "+3h"]);
    expect(m.timelineAxisLabels([])).toEqual([]);
  });

  it("ignores a stored model chip when the flag is off", async () => {
    const { MODEL_CHIPS, mapChipsFor } = await import("./map-layers");
    const storage = { getItem: () => "modelTemperature" };
    expect(readStoredMapLayer(storage)).toBeNull();
    expect(
      readStoredMapLayer(storage, mapChipsFor({ modelLayers: true })),
    ).toBe(MODEL_CHIPS[0].id);
  });
});

// Last in the file on purpose: vi.resetModules() hands later dynamic imports a
// fresh module instance, which would break the identity checks above.
describe("MapTiler key and style ids (#266)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("trims a key that ends in a newline (the deployed value does)", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_MAPTILER_API_KEY", " abc123\n");
    const m = await import("./map-layers");
    expect(m.MAPTILER_KEY).toBe("abc123");
    expect(m.MAPTILER_STYLE_LIGHT).toMatch(/\?key=abc123$/);
    expect(m.MAPTILER_STYLE_DARK).toMatch(/\?key=abc123$/);
  });

  it("builds both style URLs from the shared ids", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_MAPTILER_API_KEY", "k");
    const m = await import("./map-layers");
    expect(m.maptilerStyleId(false)).toBe(m.MAPTILER_STYLE_ID_LIGHT);
    expect(m.maptilerStyleId(true)).toBe(m.MAPTILER_STYLE_ID_DARK);
    expect(m.MAPTILER_STYLE_LIGHT).toContain(
      `/maps/${m.MAPTILER_STYLE_ID_LIGHT}/`,
    );
    expect(m.MAPTILER_STYLE_DARK).toContain(
      `/maps/${m.MAPTILER_STYLE_ID_DARK}/`,
    );
  });
});

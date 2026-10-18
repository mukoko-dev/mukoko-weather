import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Mock the Zustand store so importing MapLibreMap doesn't pull in the RxDB
// bridge / replication side effects. The pure helpers under test don't use it.
vi.mock("@/lib/store", () => ({
  useAppStore: (selector: (s: { theme: string }) => unknown) =>
    selector({ theme: "light" }),
}));

import { getMapTilerStyle, classifyMapError } from "./MapLibreMap";
import { WEATHER_OVERLAY_ID } from "@/lib/map-layers";

// Node-env structural checks (no DOM renderer) — read the component source.
const source = readFileSync(resolve(__dirname, "MapLibreMap.tsx"), "utf-8");

describe("getMapTilerStyle", () => {
  it("returns the light MapTiler streets style URL by default", () => {
    const url = getMapTilerStyle(false);
    expect(url).toContain("maptiler.com/maps/streets-v2/style.json");
    expect(url).not.toContain("streets-v2-dark");
  });

  it("returns the dark MapTiler streets style URL when isDark", () => {
    const url = getMapTilerStyle(true);
    expect(url).toContain("maptiler.com/maps/streets-v2-dark/style.json");
  });

  it("always targets MapTiler, never Mapbox", () => {
    for (const dark of [true, false]) {
      const url = getMapTilerStyle(dark);
      expect(url).toContain("maptiler.com");
      expect(url).not.toContain("mapbox.com");
    }
  });
});

describe("classifyMapError", () => {
  it("classifies weather-overlay source errors as 'overlay'", () => {
    expect(
      classifyMapError({ sourceId: WEATHER_OVERLAY_ID }, WEATHER_OVERLAY_ID),
    ).toBe("overlay");
  });

  it("classifies a style-load error with no sourceId as 'base'", () => {
    // A failed style.json fetch (expired / over-quota key → 403/429) carries no
    // sourceId — it must surface the base-map notice, not the overlay one.
    expect(
      classifyMapError(
        { error: new Error("403 Forbidden") },
        WEATHER_OVERLAY_ID,
      ),
    ).toBe("base");
  });

  it("classifies per-frame overlay sources as 'overlay'", () => {
    expect(
      classifyMapError(
        { sourceId: `${WEATHER_OVERLAY_ID}@precipitationIntensity@now` },
        WEATHER_OVERLAY_ID,
      ),
    ).toBe("overlay");
  });

  it("does not match a source that merely starts with the overlay id", () => {
    expect(
      classifyMapError(
        { sourceId: `${WEATHER_OVERLAY_ID}-extra` },
        WEATHER_OVERLAY_ID,
      ),
    ).toBe("base");
  });

  it("classifies base-tile source errors as 'base'", () => {
    expect(
      classifyMapError({ sourceId: "openmaptiles" }, WEATHER_OVERLAY_ID),
    ).toBe("base");
  });

  it("handles a null/empty event defensively as 'base'", () => {
    expect(
      classifyMapError({} as { sourceId?: string }, WEATHER_OVERLAY_ID),
    ).toBe("base");
  });
});

describe("missing-key notice (item 1 — empty NEXT_PUBLIC_MAPTILER_API_KEY)", () => {
  it("skips map init and surfaces a clear base-map notice on an empty key", () => {
    // The empty-key path must short-circuit before creating the map so it never
    // falls through to a silent blank surface or only an overlay notice.
    expect(source).toContain("baseMapMissingKey");
    expect(source).toContain("if (baseMapMissingKey) return;");
    expect(source).toContain("Base map unavailable — map key not configured");
    expect(source).toContain("NEXT_PUBLIC_MAPTILER_API_KEY");
  });
});

describe("overlay tile resilience (item 2 — decode errors non-fatal, non-spammy)", () => {
  it("rate-limits overlay error logging with a once-per-selection guard", () => {
    expect(source).toContain("overlayErrorLoggedRef");
    // Log guard resets when the selected layer changes.
    expect(source).toContain("overlayErrorLoggedRef.current = false");
  });

  it("logs overlay tile failures as a non-fatal warning, not an error", () => {
    expect(source).toContain(
      "[weather-map] weather overlay tile failed to load (non-fatal)",
    );
  });
});

describe("attribution placement (item 4 — clear the bottom-right for the switcher)", () => {
  it("disables the default (bottom-right) attribution and re-adds it bottom-left", () => {
    expect(source).toContain("attributionControl: false");
    expect(source).toContain("AttributionControl");
    expect(source).toContain('"bottom-left"');
  });
});

describe("marker theme color (issue #97)", () => {
  it("resolves the marker color from the primary token, not a hardcoded hex", () => {
    expect(source).toContain('resolveColor("var(--color-primary)")');
    expect(source).not.toContain('"#0047AB"');
  });

  it("resolves inside restore() so theme switches recolor the marker", () => {
    // restore() runs on style.load AND after each theme-driven setStyle, so the
    // resolveColor call must live inside it — not at module/mount scope.
    const restoreBlock = source.slice(
      source.indexOf("const restore = () => {"),
      source.indexOf("restoreRef.current = restore"),
    );
    expect(restoreBlock).toContain("resolveColor");
  });
});

describe("MapLibre web worker (maplibre-gl v6)", () => {
  const root = resolve(__dirname, "../../../..");
  const read = (p: string) => readFileSync(resolve(root, p), "utf-8");

  it("points setWorkerUrl at the served copy before creating a map", () => {
    // v6 loads its worker from next to the bundled chunk, where webpack never
    // emits it — without this every map renders blank ("Worker failed to load").
    const setIdx = source.indexOf("setWorkerUrl(");
    const mapIdx = source.indexOf("new Map(");
    expect(setIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeLessThan(mapIdx);
    expect(source).toContain("maplibreWorkerUrl(getVersion())");
  });

  it("serves the worker from a per-version folder the copy script fills", async () => {
    // Versioned so a tab on an old bundle never pairs with a newer worker.
    const { maplibreWorkerUrl } = await import("@/lib/map-layers");
    expect(maplibreWorkerUrl("6.12.0")).toBe(
      "/vendor/maplibre-gl/6.12.0/maplibre-gl-worker.mjs",
    );
    const script = read("scripts/copy-maplibre-worker.mjs");
    expect(script).toContain('"public", "vendor", "maplibre-gl", version');
    // The worker imports ./maplibre-gl-shared.mjs, so both must be copied.
    expect(script).toContain("maplibre-gl-worker.mjs");
    expect(script).toContain("maplibre-gl-shared.mjs");
  });

  it("copies the worker before every build and dev run", () => {
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.prebuild).toContain("copy-maplibre-worker.mjs");
    expect(pkg.scripts.predev).toContain("copy-maplibre-worker.mjs");
  });

  it("the installed maplibre-gl still ships both worker files", () => {
    const dist = resolve(root, "node_modules/maplibre-gl/dist");
    expect(() =>
      readFileSync(resolve(dist, "maplibre-gl-worker.mjs")),
    ).not.toThrow();
    expect(
      readFileSync(resolve(dist, "maplibre-gl-worker.mjs"), "utf-8"),
    ).toContain("./maplibre-gl-shared.mjs");
    // The module the worker imports must exist under exactly that name.
    expect(() =>
      readFileSync(resolve(dist, "maplibre-gl-shared.mjs")),
    ).not.toThrow();
  });

  it("keeps MapLibre's focusable controls visible to assistive tech", () => {
    // Zoom buttons and attribution links render inside the container; an
    // aria-hidden ancestor would hide focusable controls (aria-hidden-focus).
    expect(source).not.toMatch(
      /aria-hidden="true">\s*<div ref=\{containerRef\}/,
    );
  });
});

describe("map container sizing", () => {
  it("never puts the absolute fill on the MapLibre container itself", () => {
    // MapLibre's unlayered `.maplibregl-map { position: relative }` beats
    // Tailwind 4's layered `absolute`, collapsing the container to 0px tall.
    expect(source).not.toMatch(/ref=\{containerRef\}[^>]*absolute/);
    expect(source).toMatch(
      /<div className="absolute inset-0"[^>]*>\s*<div ref=\{containerRef\} className="h-full w-full"/,
    );
  });
});

describe("AQI grid overlay (Air Quality Map card)", () => {
  it("accepts an optional aqiOverlay prop that defaults to no overlay", () => {
    expect(source).toContain("aqiOverlay?: FeatureCollection | null;");
    expect(source).toContain("aqiOverlay = null,");
  });

  it("renders the overlay as a semi-transparent fill layer", () => {
    expect(source).toContain('type: "fill"');
    expect(source).toContain('"fill-opacity": 0.55');
    expect(source).toMatch(/type: "geojson",\s+data,/);
    expect(source).toContain("AQI_OVERLAY_ID");
  });

  it("colours cells with a match expression over the band property", () => {
    expect(source).toContain('"match",');
    expect(source).toContain('["get", "band"]');
    expect(source).toContain("for (const band of AQI_BANDS)");
    expect(source).toContain("AQI_BAND_SEVERITY_TOKEN[band]");
  });

  it("resolves band colours from severity tokens, not hardcoded hex", () => {
    expect(source).toContain(
      "resolveColor(`var(${AQI_BAND_SEVERITY_TOKEN[band]})`)",
    );
    expect(source).not.toMatch(/["'`]#[0-9a-fA-F]{3,8}["'`]/);
  });

  it("inserts the overlay beneath the first symbol (label) layer", () => {
    expect(source).toContain('layer.type === "symbol"');
    expect(source).toMatch(/addLayer\(\s*\{[\s\S]*?\},\s*beforeId,?\s*\)/);
  });

  it("restores the overlay after a style switch and reacts to prop changes", () => {
    expect(source).toContain("applyAqiOverlay(map, aqiOverlayRef.current);");
    expect(source).toContain("}, [aqiOverlay]);");
  });
});

describe("weather timeline + AQI bubbles (full-screen map)", () => {
  it("takes a forecast timestamp and builds one overlay source per frame", () => {
    expect(source).toContain("weatherTimestamp?: string;");
    expect(source).toContain(
      "map.addSource(id, buildWeatherOverlaySource(layer, ts))",
    );
    expect(source).toContain("overlayFrameId(layer, timestamp)");
  });

  it("never blanks the overlay by swapping tile URLs in place (#266)", () => {
    // setTiles reloads the source, which shows nothing until every new tile
    // arrives. Frames load hidden and replace the visible one once loaded.
    expect(source).not.toContain("setTiles(");
    expect(source).toContain("planOverlayFrames(");
    expect(source).toContain("swapToWantIfLoaded(");
    expect(source).toContain("map.isSourceLoaded(id)");
    expect(source).toContain('"raster-opacity": visible ? state.opacity : 0');
  });

  it("preloads an optional second frame and reports loaded frames", () => {
    expect(source).toContain("weatherPrefetchTimestamp?: string | null;");
    expect(source).toContain("weatherPrefetchTimestamp = null,");
    expect(source).toContain(
      "onWeatherFrameLoaded?: (timestamp: string) => void;",
    );
    expect(source).toContain('map.on("sourcedata"');
  });

  it("adds overlays at style.load, not after the first full render (#266)", () => {
    // "load" waits for every base tile, sprite and glyph; "idle" for every
    // tile of every source. Overlay requests must start with the base tiles.
    expect(source).toContain('map.on("style.load", restore)');
    expect(source).not.toContain('map.on("load"');
    // The only idle wait left is the model-field overlay's (not the frames').
    expect(source.split('once("idle"').length - 1).toBe(1);
    expect(source).toContain('map.once("idle", apply)');
    expect(source).toContain("styleReadyRef.current = true;");
  });

  it("never leaves a slow frame hidden behind the previous one", () => {
    // After FRAME_SWAP_TIMEOUT_MS the wanted frame is shown even while some
    // tiles are loading, and "idle" settles frames that fire no sourcedata.
    expect(source).toContain("const FRAME_SWAP_TIMEOUT_MS = 2500;");
    expect(source).toContain(
      "settleFrame(map, framesRef.current, overlayPropsRef.current, true);",
    );
    expect(source).toContain('map.on("idle", () => {');
  });

  it("keeps overlays working when a theme diff changes nothing", () => {
    // A zero-op diff fires no "style.load"; the ready flag must not drop.
    const themeEffect = source.slice(
      source.indexOf("// Switch style when theme changes."),
      source.indexOf("}, [isDark]);"),
    );
    expect(themeEffect).not.toContain("styleReadyRef.current = false");
  });

  it("ignores errors from the hidden preload frame and resets per step", () => {
    expect(source).toContain(
      "if (e.sourceId !== state.want && e.sourceId !== state.active) {",
    );
    expect(source).toContain("}, [weatherLayer, weatherTimestamp]);");
  });

  it("renders AQI bubbles as HTML markers coloured from the severity classes", () => {
    expect(source).toContain("aqiBubbles?: readonly AqBubble[] | null;");
    expect(source).toContain("new MarkerCtor({ element: el })");
    expect(source).toContain("AQI_BAND_BG_CLASS[b.band]");
    expect(source).toContain('"size-12 text-sm"');
  });

  it("removes stale bubble markers before drawing a new set", () => {
    expect(source).toContain(
      "bubbleMarkersRef.current.forEach((m) => m.remove())",
    );
  });

  it("makes the zoom control optional so the full-screen map can keep its top-right corner", () => {
    expect(source).toContain("navigationControl = true,");
    expect(source).toContain("if (interactive && navigationControl)");
  });
});

describe("classifyMapError — every overlay source", () => {
  it("treats AQ and model-field source errors as overlay errors, not base-map failures", async () => {
    const { AQI_OVERLAY_ID, MODEL_OVERLAY_ID } =
      await import("@/lib/map-layers");
    const ids = [WEATHER_OVERLAY_ID, AQI_OVERLAY_ID, MODEL_OVERLAY_ID];
    expect(classifyMapError({ sourceId: MODEL_OVERLAY_ID }, ids)).toBe(
      "overlay",
    );
    expect(classifyMapError({ sourceId: AQI_OVERLAY_ID }, ids)).toBe("overlay");
    expect(classifyMapError({ sourceId: "openmaptiles" }, ids)).toBe("base");
    expect(classifyMapError({}, ids)).toBe("base");
    expect(source).toContain("classifyMapError(e, OVERLAY_SOURCE_IDS)");
  });
});

describe("MapLibreMap — overlay sources and attribution", () => {
  it("builds the attribution control from map-sources, not a literal string", () => {
    expect(source).toContain(
      "BASE_MAP_PROVIDERS.map((id) => MAP_PROVIDERS[id])",
    );
    expect(source).not.toContain(
      '© <a href="https://www.maptiler.com/">MapTiler</a>',
    );
  });

  it("rebuilds the overlay source when the layer (and so the provider) changes", () => {
    // Frame ids carry the layer, so a new layer is a new source set, and the
    // frame opacity follows the layer's provider (GIBS imagery is more opaque).
    expect(source).toContain("overlayFrameId(layer, timestamp)");
    expect(source).toContain("state.opacity = weatherOverlayOpacity(layer);");
  });

  it("credits the AQ grid and model fields on their GeoJSON sources", () => {
    expect(source).toContain(
      'attribution: attributionHtml(overlayAttribution("airQuality"))',
    );
    expect(source).toContain("attribution: overlay.attribution");
    expect(source).toContain("MODEL_OVERLAY_ID");
  });

  it("swaps model cells in place on a timeline step instead of rebuilding the layer", () => {
    expect(source).toContain("existing.setData(overlay.data)");
    expect(source).toContain("fieldStyleOf.get(map) === style");
  });
});

describe("style attribution de-duplication", () => {
  it("strips the style's own attribution on creation and on theme switch", () => {
    expect(source).toContain("withoutStyleAttributions");
    expect(source.match(/transformStyle:/g)).toHaveLength(2);
  });
});

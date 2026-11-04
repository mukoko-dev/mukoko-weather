import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

// Mock the Zustand store so importing MapLibreMap doesn't pull in the RxDB
// bridge / replication side effects. The pure helpers under test don't use it.
vi.mock("@/lib/store", () => ({
  useAppStore: (selector: (s: { theme: string }) => unknown) =>
    selector({ theme: "light" }),
}));

import { getMapTilerStyle, classifyMapError } from "./MapLibreMap";
import { WEATHER_OVERLAY_ID, maplibreWorkerUrl } from "@/lib/map-layers";
import {
  WORKER_FILE,
  copyWorker,
  defaultOutRoot,
  relativeImports,
} from "../../../../scripts/lib/maplibre-worker.mjs";

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

  it("serves the worker from a per-version folder the copy script fills", () => {
    // Versioned so a tab on an old bundle never pairs with a newer worker.
    expect(maplibreWorkerUrl("6.12.0")).toBe(
      "/vendor/maplibre-gl/6.12.0/maplibre-gl-worker.mjs",
    );
    // /vendor/... is served from public/, so the folder the script fills by
    // default (<out root>/<version>) must be exactly the path the URL names,
    // and the file it names is the entry point the script starts from.
    expect(WORKER_FILE).toBe("maplibre-gl-worker.mjs");
    expect(join(defaultOutRoot(root), "6.12.0", WORKER_FILE)).toBe(
      join(root, "public", maplibreWorkerUrl("6.12.0")),
    );
  });

  it("copies the worker before every build and dev run", () => {
    const pkg = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.prebuild).toContain("copy-maplibre-worker.mjs");
    expect(pkg.scripts.predev).toContain("copy-maplibre-worker.mjs");
  });

  // The package has shipped two layouts: a thin worker importing a separate
  // ./maplibre-gl-shared.mjs (6.12.0), and one self-contained worker (6.13.0
  // and later, where dist/ keeps an empty, unreferenced shared placeholder). Which
  // one is installed does not matter; what must hold is that nothing the
  // worker imports is left behind. These run against whatever is installed.
  describe("the installed maplibre-gl", () => {
    const packageDir = resolve(root, "node_modules/maplibre-gl");
    const dist = resolve(packageDir, "dist");
    const workerSource = () =>
      readFileSync(resolve(dist, WORKER_FILE), "utf-8");

    it("ships a worker with code in it", () => {
      // An empty entry would load without error and then never answer.
      expect(workerSource().length).toBeGreaterThan(10_000);
    });

    it("ships every relative module the worker imports", () => {
      for (const specifier of relativeImports(workerSource())) {
        const file = resolve(dist, specifier);
        expect(existsSync(file), `${specifier} is missing from dist/`).toBe(
          true,
        );
      }
    });

    it("gets every module the worker imports beside the served copy", () => {
      const outRoot = mkdtempSync(join(tmpdir(), "maplibre-vendor-"));
      try {
        const { version, outDir, files } = copyWorker({ packageDir, outRoot });
        // The URL the browser is given points into this folder.
        const served = maplibreWorkerUrl(version);
        expect(served).toBe(`/vendor/maplibre-gl/${version}/${WORKER_FILE}`);
        expect(files[0]).toBe(WORKER_FILE);
        expect(existsSync(join(outDir, WORKER_FILE))).toBe(true);
        for (const specifier of relativeImports(workerSource())) {
          expect(
            existsSync(resolve(outDir, specifier)),
            `${specifier} must sit beside the served worker`,
          ).toBe(true);
          // And it is the real module, not an empty stand-in.
          expect(statSync(resolve(outDir, specifier)).size).toBeGreaterThan(0);
        }
      } finally {
        rmSync(outRoot, { recursive: true, force: true });
      }
    });
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

describe("data overlays (AQI grid and model fields): one smooth picture", () => {
  it("accepts an optional aqiOverlay raster that defaults to no overlay", () => {
    expect(source).toContain("aqiOverlay?: FieldRaster | null;");
    expect(source).toContain("aqiOverlay = null,");
    expect(source).toContain("fieldOverlay?: FieldOverlay | null;");
    expect(source).toContain("fieldOverlay = null,");
  });

  it("draws each overlay as ONE image source, not a polygon per sample", () => {
    expect(source).toContain('type: "image"');
    expect(source).toContain('type: "raster"');
    expect(source).toContain("updateImage({ image })");
    // No fill layer of grid cells and no per-band match expression any more.
    expect(source).not.toContain('type: "fill"');
    expect(source).not.toContain('"fill-opacity"');
    expect(source).not.toContain("aqiFillColorExpression");
    expect(source).not.toContain("applyAqiOverlay");
    expect(source).not.toContain("applyFieldOverlay");
  });

  it("hands MapLibre an already-decoded ImageData: no network request, no data URL", () => {
    expect(source).toContain("new ImageData(");
    expect(source).toContain("paintRaster(");
    expect(source).not.toContain("toDataURL");
    expect(source).not.toContain("data:image");
  });

  it("keeps the layer opacity (0.55 air quality, 0.5 model fields) on the raster layer", () => {
    expect(source).toContain("const AQI_OVERLAY_OPACITY = 0.55;");
    expect(source).toContain("const FIELD_OVERLAY_OPACITY = 0.5;");
    expect(source).toContain('"raster-opacity": opacity');
    expect(source).toContain('"raster-resampling": "linear"');
    // A timeline step must not fade: the old frame would show under the new.
    expect(source).toContain('"raster-fade-duration": 0');
  });

  it("resolves band colours from the weather-scale tokens on every apply, not hex", () => {
    // Re-run from restore() on a theme switch, so the picture follows light/dark.
    expect(source).toContain("resolveColor(`var(${token})`)");
    expect(source).toContain('resolveColor("var(--wx-outline)")');
    expect(source).not.toMatch(/["'`]#[0-9a-fA-F]{3,8}["'`]/);
  });

  it("keeps the --wx-outline rule: a vector outline where one band ends and the next starts", () => {
    expect(source).toContain("contourLines(raster)");
    expect(source).toContain('type: "line"');
    expect(source).toContain('"line-color": outlineColor');
    // One screen pixel wide at every zoom: a baked-in line would scale with the image.
    expect(source).toContain('"line-width": 1');
  });

  it("names the outline so its errors still count as overlay errors", () => {
    expect(source).toContain("return `${overlayId}@outline`;");
  });

  it("inserts the picture and its outline beneath the first symbol (label) layer", () => {
    expect(source).toContain('layer.type === "symbol"');
    expect(source).toMatch(/addLayer\(\s*\{[\s\S]*?\},\s*beforeId,?\s*\)/);
    // Raster first, outline second: the outline sits above the colour.
    expect(source.indexOf('type: "raster"')).toBeLessThan(
      source.indexOf('type: "line"'),
    );
  });

  it("restores the overlays after a style switch and reacts to prop changes", () => {
    expect(source).toMatch(
      /applyRasterOverlay\(\s*map,\s*AQI_OVERLAY_ID,\s*aqiOverlayOf\(aqiOverlayRef\.current\)/,
    );
    expect(source).toMatch(
      /applyRasterOverlay\(\s*map,\s*MODEL_OVERLAY_ID,\s*fieldOverlayRef\.current/,
    );
    expect(source).toContain("}, [aqiOverlay]);");
    expect(source).toContain("}, [fieldOverlay]);");
  });

  it("credits the data on the outline's GeoJSON source (an ImageSource has no attribution)", () => {
    expect(source).toContain('overlayAttribution("airQuality")');
    expect(source).toMatch(
      /map\.addSource\(outlineId\(id\), \{\s+type: "geojson",\s+data: outline,\s+attribution,/,
    );
  });

  it("swaps the image and outline in place on a timeline step instead of rebuilding", () => {
    expect(source).toMatch(
      /source\.updateImage\(\{\s*image,\s*coordinates: raster\.corners\s*\}\)/,
    );
    expect(source).toContain("outlineSource.setData(outline);");
    expect(source).toContain("credits.get(id) === attribution");
  });

  it("falls back to the browser to read a colour it cannot parse, then to neutral grey", () => {
    expect(source).toContain("parseCssColor(css)");
    expect(source).toContain("getImageData(0, 0, 1, 1)");
    expect(source).toContain("return [128, 128, 128];");
  });

  it("clears both layers and both sources when the overlay goes", () => {
    const remove = source.slice(
      source.indexOf("function removeRasterOverlay"),
      source.indexOf("/**\n * Adds (or replaces) a data overlay"),
    );
    expect(remove).toContain("map.removeLayer(outlineId(id))");
    expect(remove).toContain("map.removeLayer(id)");
    expect(remove).toContain("map.removeSource(outlineId(id))");
    expect(remove).toContain("map.removeSource(id)");
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
    // No overlay (frames, AQI grid, model field) waits for a one-off "idle".
    expect(source).not.toContain('once("idle"');
    expect(source).toContain("styleReadyRef.current = true;");
  });

  it("applies the model-field overlay as soon as the style is ready", () => {
    // A model timeline step is an updateImage; deferring it to "idle" would
    // hold it behind every base tile still loading.
    const fieldEffect = source.slice(
      source.indexOf("// Switch the model-field overlay"),
      source.indexOf("}, [fieldOverlay]);"),
    );
    expect(fieldEffect).toContain("if (!styleReadyRef.current) return;");
    expect(fieldEffect).toMatch(
      /applyRasterOverlay\(\s*map,\s*MODEL_OVERLAY_ID,\s*fieldOverlay,\s*FIELD_OVERLAY_OPACITY/,
    );
    expect(fieldEffect).not.toContain("isStyleLoaded");
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

  it("renders AQI bubbles as HTML markers coloured from the weather-scale classes", () => {
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
});

describe("GIBS zoom cap (a satellite layer cannot show more than its data holds)", () => {
  it("creates the map with the active layer's cap", () => {
    expect(source).toMatch(
      /maxZoom: maxMapZoomFor\(\s*overlayPropsRef\.current\.layer,\s*MAP_MAX_ZOOM_DEFAULT,?\s*\)/,
    );
  });

  const effect = source.slice(
    source.indexOf("// Cap the zoom at what the active layer's data can show."),
    source.indexOf("// Switch the weather overlay frame when the layer"),
  );

  it("re-caps on every layer change and gives the default back to non-GIBS layers", () => {
    expect(effect).toContain(
      "const cap = maxMapZoomFor(weatherLayer, MAP_MAX_ZOOM_DEFAULT);",
    );
    expect(effect).toContain("if (map.getMaxZoom() === cap) return;");
    expect(effect).toContain("}, [weatherLayer]);");
  });

  it("eases down to the cap instead of jumping, then locks the maximum", () => {
    expect(effect).toContain("planZoomCap(map.getZoom(), cap)");
    expect(effect).toContain(
      "map.easeTo({ zoom: plan.easeTo, duration: ZOOM_CAP_EASE_MS })",
    );
    expect(effect).toContain('map.once("moveend"');
    // MapLibre's easeTo is already instant under prefers-reduced-motion unless
    // marked essential: never mark this one.
    expect(effect).not.toContain("essential");
  });

  it("registers the lock BEFORE starting the ease, so an instant ease (reduced motion) still locks", () => {
    // MapLibre finishes a zero-duration ease inside easeTo and fires
    // "moveend" there; a listener added after the call would miss it.
    const listener = effect.indexOf('map.once("moveend"');
    const ease = effect.indexOf("map.easeTo(");
    expect(listener).toBeGreaterThan(-1);
    expect(ease).toBeGreaterThan(-1);
    expect(listener).toBeLessThan(ease);
  });

  it("locks the CURRENT layer's cap when the ease ends, so switching mid-ease leaves no stale cap", () => {
    const lock = effect.slice(
      effect.indexOf('map.once("moveend"'),
      effect.indexOf("}, [weatherLayer]);"),
    );
    expect(lock).toContain("overlayPropsRef.current.layer");
    expect(lock).not.toContain("weatherLayer");
    expect(lock).not.toContain("setMaxZoom(cap)");
  });
});

describe("style attribution de-duplication", () => {
  it("strips the style's own attribution on creation and on theme switch", () => {
    expect(source).toContain("withoutStyleAttributions");
    expect(source.match(/transformStyle:/g)).toHaveLength(2);
  });
});

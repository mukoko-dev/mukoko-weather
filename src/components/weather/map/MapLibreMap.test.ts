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
    // restore() runs on load AND after each theme-driven setStyle, so the
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
    expect(source).toContain('type: "geojson", data');
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

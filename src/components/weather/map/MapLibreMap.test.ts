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

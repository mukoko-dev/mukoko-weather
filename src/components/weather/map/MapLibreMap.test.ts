import { describe, it, expect, vi } from "vitest";

// Mock the Zustand store so importing MapLibreMap doesn't pull in the RxDB
// bridge / replication side effects. The pure helpers under test don't use it.
vi.mock("@/lib/store", () => ({
  useAppStore: (selector: (s: { theme: string }) => unknown) =>
    selector({ theme: "light" }),
}));

import { getMapTilerStyle, classifyMapError } from "./MapLibreMap";
import { WEATHER_OVERLAY_ID } from "@/lib/map-layers";

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
      classifyMapError({ error: new Error("403 Forbidden") }, WEATHER_OVERLAY_ID),
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

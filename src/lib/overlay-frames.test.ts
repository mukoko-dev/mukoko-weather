import { describe, it, expect } from "vitest";
import {
  overlayFrameId,
  overlayFrameLayer,
  planOverlayFrames,
} from "./overlay-frames";
import {
  WEATHER_OVERLAY_ID,
  WEATHER_OVERLAY_MAX_ZOOM,
  buildWeatherOverlaySource,
} from "./map-layers";
import { GIBS_LAYERS, satelliteFrames } from "./map-sources";

const now = overlayFrameId("precipitationIntensity", "now");
const t3 = overlayFrameId("precipitationIntensity", "2026-10-11T10:00:00Z");
const t6 = overlayFrameId("precipitationIntensity", "2026-10-11T13:00:00Z");
const temp = overlayFrameId("temperature", "now");

describe("overlayFrameId", () => {
  it("is unique per layer and timestamp and keeps the overlay prefix", () => {
    expect(now).toBe(`${WEATHER_OVERLAY_ID}@precipitationIntensity@now`);
    expect(new Set([now, t3, t6, temp]).size).toBe(4);
  });
});

describe("planOverlayFrames", () => {
  it("shows the first frame at once so it paints tile by tile", () => {
    const plan = planOverlayFrames({
      present: [],
      active: null,
      want: now,
      prefetch: null,
    });
    expect(plan).toEqual({ add: [now], remove: [], showWantNow: true });
  });

  it("adds a new step hidden and keeps the visible frame until it loads", () => {
    const plan = planOverlayFrames({
      present: [now],
      active: now,
      want: t3,
      prefetch: null,
    });
    expect(plan.add).toEqual([t3]);
    expect(plan.remove).toEqual([]);
    expect(plan.showWantNow).toBe(false);
  });

  it("preloads the next frame alongside the wanted one", () => {
    const plan = planOverlayFrames({
      present: [now],
      active: now,
      want: t3,
      prefetch: t6,
    });
    expect(plan.add).toEqual([t3, t6]);
    expect(plan.showWantNow).toBe(false);
  });

  it("reuses an already-preloaded frame instead of adding it again", () => {
    const plan = planOverlayFrames({
      present: [now, t3],
      active: now,
      want: t3,
      prefetch: t6,
    });
    expect(plan.add).toEqual([t6]);
    expect(plan.remove).toEqual([]);
  });

  it("drops frames that are neither wanted, preloaded nor visible", () => {
    const plan = planOverlayFrames({
      present: [now, t3, t6],
      active: t3,
      want: t6,
      prefetch: null,
    });
    expect(plan.remove).toEqual([now]);
    expect(plan.add).toEqual([]);
  });

  it("never keeps more than three frames", () => {
    const present = [now, t3, t6, temp];
    const plan = planOverlayFrames({
      present,
      active: now,
      want: t3,
      prefetch: t6,
    });
    expect(present.length - plan.remove.length + plan.add.length).toBe(3);
  });

  it("is a no-op for the frame already on screen", () => {
    const plan = planOverlayFrames({
      present: [now],
      active: now,
      want: now,
      prefetch: null,
    });
    expect(plan).toEqual({ add: [], remove: [], showWantNow: true });
  });

  it("ignores a prefetch equal to the wanted frame", () => {
    const plan = planOverlayFrames({
      present: [],
      active: null,
      want: now,
      prefetch: now,
    });
    expect(plan.add).toEqual([now]);
  });

  it("clears everything when no layer is wanted", () => {
    const plan = planOverlayFrames({
      present: [now, t3],
      active: now,
      want: null,
      prefetch: t6,
    });
    expect(plan.remove).toEqual([now, t3]);
    expect(plan.add).toEqual([]);
  });

  it("treats a stale active id (no longer on the map) as nothing on screen", () => {
    const plan = planOverlayFrames({
      present: [],
      active: now,
      want: t3,
      prefetch: null,
    });
    expect(plan.showWantNow).toBe(true);
    expect(plan.add).toEqual([t3]);
  });
});

describe("overlayFrameLayer", () => {
  it("reads the layer out of a frame id", () => {
    expect(overlayFrameLayer(now)).toBe("precipitationIntensity");
    expect(overlayFrameLayer(temp)).toBe("temperature");
    expect(overlayFrameLayer(WEATHER_OVERLAY_ID)).toBeNull();
    expect(overlayFrameLayer("openmaptiles")).toBeNull();
    expect(overlayFrameLayer(null)).toBeNull();
  });

  it("switching layers replaces the visible frame at once", () => {
    const plan = planOverlayFrames({
      present: [now],
      active: now,
      want: temp,
      prefetch: null,
    });
    expect(plan.remove).toEqual([now]);
    expect(plan.add).toEqual([temp]);
    expect(plan.showWantNow).toBe(true);
  });
});

describe("planOverlayFrames — stale active equal to want", () => {
  it("re-adds the wanted frame when its old copy is gone", () => {
    const plan = planOverlayFrames({
      present: [],
      active: now,
      want: now,
      prefetch: null,
    });
    expect(plan.add).toEqual([now]);
    expect(plan.showWantNow).toBe(true);
  });
});

describe("NASA GIBS timelines through the frame plan (#266)", () => {
  // Mid-morning UTC: the daily layer's newest complete day is yesterday.
  const clock = new Date("2026-11-03T10:20:00Z");

  for (const layer of Object.values(GIBS_LAYERS)) {
    describe(layer.chipId, () => {
      const frames = satelliteFrames(layer, null, clock);
      const ids = frames.map((f) => overlayFrameId(layer.chipId, f.time));

      it("has one distinct frame id per timestamp, none in the future", () => {
        expect(frames.length).toBe(layer.frames);
        expect(new Set(ids).size).toBe(frames.length);
        for (const f of frames) {
          // GIBS answers a future instant with 404, so a frame must never be
          // one, however far ahead the preload looks.
          expect(Date.parse(f.time)).toBeLessThanOrEqual(clock.getTime());
        }
      });

      it("builds each frame from the layer's own GIBS tiles, not the Tomorrow.io overlay", () => {
        for (const f of frames) {
          const src = buildWeatherOverlaySource(layer.chipId, f.time);
          expect(src.tiles[0]).toContain("gibs.earthdata.nasa.gov");
          expect(src.tiles[0]).toContain(encodeURIComponent(f.time));
          // WMTS tiles are 256 px; a WMS layer (wildfire) asks for 512 px.
          expect(src.tileSize).toBe(layer.service === "wms" ? 512 : 256);
          expect(src.maxzoom).toBe(layer.maxZoom);
          expect(src.maxzoom).not.toBe(WEATHER_OVERLAY_MAX_ZOOM);
        }
      });

      it("steps through every frame without blanking and with at most three loaded", () => {
        let present: string[] = [];
        let active: string | null = null;
        frames.forEach((_, i) => {
          const want = ids[i];
          // Playback preloads the next stop, wrapping at the end of the loop.
          const prefetch = ids[(i + 1) % ids.length];
          const plan = planOverlayFrames({ present, active, want, prefetch });
          // Only the very first frame paints straight away; every later step
          // keeps the visible frame until the new one has loaded.
          expect(plan.showWantNow).toBe(i === 0);
          if (i > 0) expect(plan.remove).not.toContain(active);
          present = [
            ...present.filter((id) => !plan.remove.includes(id)),
            ...plan.add,
          ];
          expect(present.length).toBeLessThanOrEqual(3);
          // The wanted frame loaded: it replaces the visible one.
          active = want;
        });
      });
    });
  }

  it("switching between the two satellite layers replaces the visible frame at once", () => {
    const rain = satelliteFrames(GIBS_LAYERS.satelliteRain, null, clock);
    const colour = satelliteFrames(GIBS_LAYERS.satellite, null, clock);
    const from = overlayFrameId("satelliteRain", rain.at(-1)!.time);
    const to = overlayFrameId("satellite", colour.at(-1)!.time);
    const plan = planOverlayFrames({
      present: [from],
      active: from,
      want: to,
      prefetch: null,
    });
    expect(plan.remove).toEqual([from]);
    expect(plan.showWantNow).toBe(true);
  });
});

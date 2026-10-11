import { describe, it, expect } from "vitest";
import {
  OVERLAY_OPACITY,
  overlayFrameId,
  overlayFrameLayer,
  planOverlayFrames,
} from "./overlay-frames";
import { WEATHER_OVERLAY_ID } from "./map-layers";

const now = overlayFrameId("precipitationIntensity", "now");
const t3 = overlayFrameId("precipitationIntensity", "2026-10-11T10:00:00Z");
const t6 = overlayFrameId("precipitationIntensity", "2026-10-11T13:00:00Z");
const temp = overlayFrameId("temperature", "now");

describe("overlayFrameId", () => {
  it("is unique per layer and timestamp and keeps the overlay prefix", () => {
    expect(now).toBe(`${WEATHER_OVERLAY_ID}@precipitationIntensity@now`);
    expect(new Set([now, t3, t6, temp]).size).toBe(4);
  });

  it("uses the same opacity as the old single overlay", () => {
    expect(OVERLAY_OPACITY).toBe(0.6);
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

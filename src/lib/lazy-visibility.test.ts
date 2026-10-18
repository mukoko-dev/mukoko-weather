import { describe, it, expect } from "vitest";
import {
  hasLayoutBox,
  isConstrainedDevice,
  loadMarginPx,
  maxConcurrentMounts,
  MIN_UNLOAD_MARGIN_PX,
  readDeviceHints,
  reservedHeightPx,
  settleDelayMs,
  shouldUnloadSection,
  unloadMarginPx,
  type DeviceHints,
} from "./lazy-visibility";

describe("shouldUnloadSection", () => {
  it("unloads a laid-out section that left the unload margin", () => {
    expect(
      shouldUnloadSection({ isIntersecting: false, hasLayoutBox: true }),
    ).toBe(true);
  });

  it("keeps a section that is still inside the unload margin", () => {
    expect(
      shouldUnloadSection({ isIntersecting: true, hasLayoutBox: true }),
    ).toBe(false);
  });

  it("never unloads a box-less (display: none) section — the flicker loop", () => {
    // IntersectionObserver reports a display:none target as not intersecting
    // regardless of where it is. Unloading it re-showed the skeleton, which
    // un-hid the wrapper, which remounted the empty card, which hid it again.
    expect(
      shouldUnloadSection({ isIntersecting: false, hasLayoutBox: false }),
    ).toBe(false);
  });

  it("is stable when the same box-less entry fires repeatedly", () => {
    const entry = { isIntersecting: false, hasLayoutBox: false };
    const decisions = Array.from({ length: 20 }, () =>
      shouldUnloadSection(entry),
    );
    expect(decisions.every((d) => d === false)).toBe(true);
  });
});

describe("hasLayoutBox", () => {
  it("is false when the element has no client rects (display: none)", () => {
    const el = { getClientRects: () => [] } as unknown as Element;
    expect(hasLayoutBox(el)).toBe(false);
  });

  it("is true when the element has at least one client rect", () => {
    const el = { getClientRects: () => [{}] } as unknown as Element;
    expect(hasLayoutBox(el)).toBe(true);
  });
});

describe("reservedHeightPx", () => {
  it("reserves the measured height, rounded up to a whole pixel", () => {
    expect(reservedHeightPx(492)).toBe(492);
    expect(reservedHeightPx(491.2)).toBe(492);
  });

  it("reserves nothing for an empty or invalid measurement", () => {
    expect(reservedHeightPx(0)).toBeNull();
    expect(reservedHeightPx(-10)).toBeNull();
    expect(reservedHeightPx(Number.NaN)).toBeNull();
    expect(reservedHeightPx(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("mount schedule", () => {
  const phone: DeviceHints = {
    viewportWidth: 412,
    viewportHeight: 915,
    deviceMemory: 4,
  };
  const desktop: DeviceHints = {
    viewportWidth: 1440,
    viewportHeight: 900,
    deviceMemory: 8,
  };
  const lowEnd: DeviceHints = {
    viewportWidth: 360,
    viewportHeight: 740,
    deviceMemory: 2,
  };

  it("starts loading 1.5 viewports ahead on capable devices", () => {
    expect(loadMarginPx(phone)).toBe(Math.round(915 * 1.5));
    expect(loadMarginPx(desktop)).toBe(1350);
  });

  it("loads far more than the old 100px ahead on phones", () => {
    expect(loadMarginPx(phone)).toBeGreaterThanOrEqual(400);
    expect(loadMarginPx(lowEnd)).toBeGreaterThanOrEqual(400);
  });

  it("clamps the load margin to 400–1600px", () => {
    expect(loadMarginPx({ viewportWidth: 300, viewportHeight: 100 })).toBe(400);
    expect(loadMarginPx({ viewportWidth: 3000, viewportHeight: 4000 })).toBe(
      1600,
    );
    expect(loadMarginPx({ viewportWidth: 300, viewportHeight: NaN })).toBe(
      1200,
    );
  });

  it("keeps the unload margin at least twice the load margin", () => {
    for (const h of [phone, desktop, lowEnd]) {
      const load = loadMarginPx(h);
      expect(unloadMarginPx(load)).toBeGreaterThanOrEqual(load * 2);
      expect(unloadMarginPx(load)).toBeGreaterThanOrEqual(MIN_UNLOAD_MARGIN_PX);
    }
  });

  it("never unloads under 1500px", () => {
    expect(unloadMarginPx(0)).toBe(1500);
    expect(unloadMarginPx(400)).toBe(1500);
  });

  it("allows two concurrent mounts on capable devices, one on constrained ones", () => {
    expect(maxConcurrentMounts(phone)).toBe(2);
    expect(maxConcurrentMounts(desktop)).toBe(2);
    expect(maxConcurrentMounts(lowEnd)).toBe(1);
    expect(maxConcurrentMounts({ ...phone, saveData: true })).toBe(1);
  });

  it("treats unknown memory as capable", () => {
    expect(
      isConstrainedDevice({ viewportWidth: 412, viewportHeight: 915 }),
    ).toBe(false);
  });

  it("flags Save-Data and ≤2 GB memory as constrained", () => {
    expect(isConstrainedDevice({ ...phone, saveData: true })).toBe(true);
    expect(isConstrainedDevice({ ...phone, deviceMemory: 2 })).toBe(true);
  });

  it("never uses the core count (iOS WebKit and Firefox RFP report 2)", () => {
    const iphone = {
      viewportWidth: 390,
      viewportHeight: 844,
      hardwareConcurrency: 2,
    } as DeviceHints;
    expect(isConstrainedDevice(iphone)).toBe(false);
    expect(maxConcurrentMounts(iphone)).toBe(2);
  });

  it("settles a frame or two between mounts, longer on constrained devices", () => {
    expect(settleDelayMs(phone)).toBeLessThan(150);
    expect(settleDelayMs(desktop)).toBeLessThanOrEqual(settleDelayMs(phone));
    expect(settleDelayMs(lowEnd)).toBeGreaterThan(settleDelayMs(phone));
  });

  it("returns safe defaults on the server", () => {
    const h = readDeviceHints();
    expect(h.viewportWidth).toBeGreaterThan(0);
    expect(h.viewportHeight).toBeGreaterThan(0);
  });
});

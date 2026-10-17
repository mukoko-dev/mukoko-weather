import { describe, it, expect } from "vitest";
import {
  readBackdropHints,
  shouldAnimateBackdrop,
  shouldRunBackdrop,
  SKY_VISIBLE_VIEWPORTS,
} from "./backdrop-policy";

describe("shouldAnimateBackdrop", () => {
  const capable = {
    reducedMotion: false,
    deviceMemory: 8,
  };

  it("animates on a capable device", () => {
    expect(shouldAnimateBackdrop(capable)).toBe(true);
  });

  it("animates when the browser does not report memory", () => {
    expect(shouldAnimateBackdrop({ reducedMotion: false })).toBe(true);
  });

  it("keeps the static sky for prefers-reduced-motion", () => {
    expect(shouldAnimateBackdrop({ ...capable, reducedMotion: true })).toBe(
      false,
    );
  });

  it("keeps the static sky under Save-Data", () => {
    expect(shouldAnimateBackdrop({ ...capable, saveData: true })).toBe(false);
  });

  it("keeps the static sky on ≤ 2 GB devices", () => {
    expect(shouldAnimateBackdrop({ ...capable, deviceMemory: 2 })).toBe(false);
    expect(shouldAnimateBackdrop({ ...capable, deviceMemory: 1 })).toBe(false);
  });

  it("does not treat a reported core count of 2 as low-end (older iOS, Firefox RFP)", () => {
    const iphone = {
      reducedMotion: false,
      hardwareConcurrency: 2,
    } as Parameters<typeof shouldAnimateBackdrop>[0];
    expect(shouldAnimateBackdrop(iphone)).toBe(true);
  });

  it("is static on the server (no window)", () => {
    expect(shouldAnimateBackdrop(readBackdropHints())).toBe(false);
  });
});

describe("shouldRunBackdrop", () => {
  const base = {
    tabVisible: true,
    scrolling: false,
    scrollY: 0,
    viewportHeight: 900,
  };

  it("runs at the top of a visible page", () => {
    expect(shouldRunBackdrop(base)).toBe(true);
  });

  it("idles in a hidden tab", () => {
    expect(shouldRunBackdrop({ ...base, tabVisible: false })).toBe(false);
  });

  it("idles while the reader is scrolling", () => {
    expect(shouldRunBackdrop({ ...base, scrolling: true })).toBe(false);
  });

  it("idles once the sky region has scrolled away", () => {
    expect(
      shouldRunBackdrop({
        ...base,
        scrollY: 900 * SKY_VISIBLE_VIEWPORTS + 1,
      }),
    ).toBe(false);
    expect(shouldRunBackdrop({ ...base, scrollY: 900 })).toBe(true);
  });
});

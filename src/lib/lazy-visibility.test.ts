import { describe, it, expect } from "vitest";
import {
  hasLayoutBox,
  reservedHeightPx,
  shouldUnloadSection,
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

import { describe, it, expect } from "vitest";
import { FLIGHT_CATEGORY_STYLES, getFlightCategoryClass } from "./flight-category-styles";

describe("FLIGHT_CATEGORY_STYLES", () => {
  it("defines all four flight categories", () => {
    expect(Object.keys(FLIGHT_CATEGORY_STYLES).sort()).toEqual(
      ["IFR", "LIFR", "MVFR", "VFR"].sort()
    );
  });

  it("uses the theme-aware severity-fg token, not hardcoded white text", () => {
    // Dark-mode severity colors are bright — text-white would be unreadable
    // (see --color-severity-fg in globals.css). Every severity-colored
    // category must use the theme-aware foreground token instead.
    expect(FLIGHT_CATEGORY_STYLES.VFR).toContain("text-severity-fg");
    expect(FLIGHT_CATEGORY_STYLES.IFR).toContain("text-severity-fg");
    expect(FLIGHT_CATEGORY_STYLES.LIFR).toContain("text-severity-fg");
    expect(FLIGHT_CATEGORY_STYLES.VFR).not.toContain("text-white");
    expect(FLIGHT_CATEGORY_STYLES.IFR).not.toContain("text-white");
    expect(FLIGHT_CATEGORY_STYLES.LIFR).not.toContain("text-white");
  });
});

describe("getFlightCategoryClass", () => {
  it("returns the mapped class for known categories", () => {
    expect(getFlightCategoryClass("VFR")).toBe(FLIGHT_CATEGORY_STYLES.VFR);
    expect(getFlightCategoryClass("LIFR")).toBe(FLIGHT_CATEGORY_STYLES.LIFR);
  });

  it("falls back to a neutral class for unknown categories", () => {
    expect(getFlightCategoryClass("UNKNOWN")).toBe("bg-surface-dim text-text-secondary");
  });
});

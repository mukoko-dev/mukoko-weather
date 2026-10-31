import { describe, it, expect } from "vitest";
import {
  FLIGHT_CATEGORY_STYLES,
  getFlightCategoryClass,
} from "./flight-category-styles";

describe("FLIGHT_CATEGORY_STYLES", () => {
  it("defines all four flight categories", () => {
    expect(Object.keys(FLIGHT_CATEGORY_STYLES).sort()).toEqual(
      ["IFR", "LIFR", "MVFR", "VFR"].sort(),
    );
  });

  it("uses the aviation-chart weather-scale tokens, not brand or severity colours", () => {
    for (const cls of Object.values(FLIGHT_CATEGORY_STYLES)) {
      expect(cls).toMatch(/^bg-wx-flight-\d /);
      expect(cls).not.toMatch(/severity|mineral|text-white/);
      expect(cls).toMatch(/text-wx-fg-(dark|light)/);
    }
  });
});

describe("getFlightCategoryClass", () => {
  it("returns the mapped class for known categories", () => {
    expect(getFlightCategoryClass("VFR")).toBe(FLIGHT_CATEGORY_STYLES.VFR);
    expect(getFlightCategoryClass("LIFR")).toBe(FLIGHT_CATEGORY_STYLES.LIFR);
  });

  it("falls back to a neutral class for unknown categories", () => {
    expect(getFlightCategoryClass("UNKNOWN")).toBe(
      "bg-surface-dim text-text-secondary",
    );
  });
});

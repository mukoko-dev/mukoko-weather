import { describe, it, expect } from "vitest";

import { isImmersivePath } from "./chrome-context";

describe("isImmersivePath", () => {
  it("is true for the weather map of any place and the wall display", () => {
    expect(isImmersivePath("/harare/map")).toBe(true);
    expect(isImmersivePath("/koh-samui--w4v7zq1/map")).toBe(true);
    expect(isImmersivePath("/display")).toBe(true);
  });

  it("is false for every page that carries the site chrome", () => {
    for (const p of [
      "/",
      "/harare",
      "/harare/forecast",
      "/harare/atmosphere",
      "/harare/agriculture",
      "/locations",
      "/explore",
      "/explore/country/zw",
      "/profile",
      "/history",
      "/aviation",
      "/about",
      "/releases",
    ]) {
      expect(isImmersivePath(p), p).toBe(false);
    }
  });

  it("does not match a place that merely contains 'map' or a deeper path", () => {
    expect(isImmersivePath("/mapleton")).toBe(false);
    expect(isImmersivePath("/harare/map/extra")).toBe(false);
    expect(isImmersivePath("/display/other")).toBe(false);
  });
});

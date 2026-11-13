import { describe, expect, it } from "vitest";
import { PREVIEW_ROUTES, SERVED_ROUTES, isAstroRoute } from "./routes";

describe("isAstroRoute", () => {
  it("is true for the pages this app serves and for its preview pages", () => {
    for (const path of [...SERVED_ROUTES, ...PREVIEW_ROUTES]) {
      expect(isAstroRoute(path)).toBe(true);
    }
  });

  it("is false for pages the Next.js app still owns", () => {
    for (const href of [
      "/",
      "/explore",
      "/harare--ksy4dd1",
      "/privacy",
      "/api/og",
    ]) {
      expect(isAstroRoute(href)).toBe(false);
    }
  });

  it("ignores a query, a hash and a trailing slash", () => {
    expect(isAstroRoute("/about?x=1")).toBe(true);
    expect(isAstroRoute("/about#team")).toBe(true);
    expect(isAstroRoute("/about/")).toBe(true);
  });

  it("is false for another origin and for mailto: and tel: links", () => {
    for (const href of [
      "https://weather.mukoko.com/about",
      "//weather.mukoko.com/about",
      "mailto:hi@mukoko.com",
      "tel:+263000000",
    ]) {
      expect(isAstroRoute(href)).toBe(false);
    }
  });

  it("keeps preview pages out of the served list (they are never routed or indexed)", () => {
    for (const path of PREVIEW_ROUTES) {
      expect(SERVED_ROUTES).not.toContain(path);
    }
  });
});

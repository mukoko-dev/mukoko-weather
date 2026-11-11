import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, it, expect } from "vitest";

import { isImmersivePath, showsQuickActions } from "./chrome-context";

const read = (p: string) => readFileSync(resolve(__dirname, p), "utf-8");

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

describe("showsQuickActions: only the embed's iframe views and the wall display are left without the group", () => {
  it("leaves out every view under /embed/ (the widget lives inside other people's pages)", () => {
    for (const p of [
      "/embed/widget",
      "/embed/anything",
      "/embed/widget/extra",
    ]) {
      expect(showsQuickActions(p), p).toBe(false);
    }
  });

  it("leaves out the wall display, a kiosk nobody taps", () => {
    expect(showsQuickActions("/display")).toBe(false);
  });

  it("keeps it on every other page, /embed itself (the page about the widget) and a path under /display included", () => {
    for (const p of [
      "/",
      "/harare",
      "/harare/forecast",
      "/harare/map",
      "/locations",
      "/explore",
      "/profile",
      "/releases",
      "/embed",
      "/display/other",
    ]) {
      expect(showsQuickActions(p), p).toBe(true);
    }
  });

  it("is not who draws the group: that is decided by what renders, and counted by chrome.render.test.ts", () => {
    // The predicate only says where the group is never drawn. Neither it nor
    // the path says who draws it elsewhere, so no second owner can disagree
    // with the page about it.
    const header = read("Header.tsx");
    const chrome = read("AppChrome.tsx");
    expect(header.match(/<QuickActions/g)).toHaveLength(1);
    expect(chrome).not.toContain("<QuickActions");
    expect(read("../../app/[location]/map/MapDashboard.tsx")).toContain(
      "<QuickActions",
    );
  });
});

describe("one header and one footer per app (Mzizi N7)", () => {
  it("AppChrome mounts both the site header and the site footer", () => {
    const src = read("AppChrome.tsx");
    expect(src).toContain("<SiteHeader />");
    expect(src).toContain("<SiteFooter />");
  });
  it("the page-level Footer renders nothing while the chrome is claimed", () => {
    expect(read("Footer.tsx")).toContain(
      "useChromeClaimed() ? null : <SiteFooter />",
    );
  });
});

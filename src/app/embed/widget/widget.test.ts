import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

/**
 * Tests for the standalone iframe widget route (/embed/widget).
 *
 * This is the URL users put in an <iframe src>. It must render ONLY the widget
 * (no Header/Footer/nav), validate its query params, and strip the app's global
 * brand chrome so the embed is self-contained.
 */

const pagePath = resolve(__dirname, "./page.tsx");
const pageContent = readFileSync(pagePath, "utf-8");

const cssPath = resolve(__dirname, "./widget.css");
const cssContent = readFileSync(cssPath, "utf-8");

describe("embed widget route — page", () => {
  it("renders the shared MukokoWeatherEmbed component", () => {
    expect(pageContent).toContain("MukokoWeatherEmbed");
    expect(pageContent).toContain('from "@/components/embed"');
    expect(pageContent).toContain("<MukokoWeatherEmbed");
  });

  it("reads query params via the Next 16 async searchParams API", () => {
    expect(pageContent).toContain("searchParams: Promise<");
    expect(pageContent).toContain("await searchParams");
  });

  it("passes all documented params through to the widget", () => {
    for (const prop of ["type=", "location=", "lat=", "lon=", "theme="]) {
      expect(pageContent).toContain(prop);
    }
  });

  it("validates type against exactly the four supported variants", () => {
    expect(pageContent).toContain('"current"');
    expect(pageContent).toContain('"today"');
    expect(pageContent).toContain('"5day"');
    expect(pageContent).toContain('"7day"');
    // Falls back to "current" for anything unexpected.
    expect(pageContent).toMatch(/\?\s*\([\s\S]*?\)\s*:\s*"current"/);
  });

  it("accepts both location and slug for the location slug", () => {
    expect(pageContent).toContain("sp.location");
    expect(pageContent).toContain("sp.slug");
  });

  it("only accepts explicit light/dark, otherwise auto", () => {
    expect(pageContent).toContain('value === "light" || value === "dark"');
    expect(pageContent).toContain('"auto"');
  });

  it("marks the embed target as noindex (not a public landing page)", () => {
    expect(pageContent).toContain("robots:");
    expect(pageContent).toContain("index: false");
  });

  it("does not render app chrome (no Header/Footer imports)", () => {
    expect(pageContent).not.toContain("components/layout/Header");
    expect(pageContent).not.toContain("components/layout/Footer");
  });

  it("does not use inline style objects", () => {
    expect(pageContent).not.toMatch(/style=\{\{/);
  });
});

describe("embed widget route — standalone CSS", () => {
  it("hides the global mineral stripe chrome for the embed", () => {
    expect(cssContent).toContain(".minerals-stripe");
    expect(cssContent).toContain("display: none");
  });

  it("uses a transparent background so the host page shows through", () => {
    expect(cssContent).toContain("background: transparent");
  });
});

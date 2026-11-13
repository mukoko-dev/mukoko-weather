import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "GoogleAnalytics.tsx"), "utf-8");

describe("GoogleAnalytics loads gtag.js after the first screen (issue 551)", () => {
  // gtag.js for the property is 181 KB gzipped. As an afterInteractive script
  // with a preload in the head it shared a slow link with the stylesheet and the
  // app's scripts and parsed while the weather was drawn.
  const gtagStart = source.indexOf("<Script\n          src=");
  const conditionalStart = source.indexOf("{loadGtag && (");
  const conditionalEnd = source.indexOf(")}", conditionalStart);
  const inlineStart = source.indexOf('<Script id="google-analytics"');

  it("renders the gtag.js script only once the first screen is done", () => {
    expect(conditionalStart).toBeGreaterThan(-1);
    expect(gtagStart).toBeGreaterThan(conditionalStart);
    expect(gtagStart).toBeLessThan(conditionalEnd);
    expect(source).toContain("https://www.googletagmanager.com/gtag/js?id=");
  });

  it("waits for the weather to paint (home page) and then an idle moment", () => {
    expect(source).toContain("storageMayStart()");
    expect(source).toContain("afterPaintWhenIdle(");
  });

  it("still defines gtag and the data layer at once, so early events are queued, not dropped", () => {
    expect(inlineStart).toBeGreaterThan(conditionalEnd);
    expect(source).toContain("window.dataLayer = window.dataLayer || [];");
    expect(source).toContain("function gtag(){dataLayer.push(arguments);}");
    expect(source).toContain("send_page_view: false");
  });

  it("keeps the sanitised page view tracker", () => {
    expect(source).toContain("<PageViewTracker />");
    expect(source).toContain("sendSanitisedPageView");
  });
});

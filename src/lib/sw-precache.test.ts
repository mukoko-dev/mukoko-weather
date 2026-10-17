import { describe, it, expect } from "vitest";
import { precacheEntries, shouldPrecache } from "./sw-precache";

describe("service worker precache filter", () => {
  it("keeps stylesheets and public icons", () => {
    expect(shouldPrecache({ url: "/_next/static/css/abc.css" })).toBe(true);
    expect(shouldPrecache({ url: "/icon-192.png" })).toBe(true);
    expect(shouldPrecache({ url: "/favicon.ico" })).toBe(true);
    expect(shouldPrecache("/favicon.svg")).toBe(true);
  });

  it("leaves JS chunks, fonts and build manifests to the runtime cache", () => {
    for (const url of [
      "/_next/static/chunks/1052.1fd64d039348f908.js",
      "/_next/static/media/0aa834ed78bf6d07-s.woff2",
      "/_next/static/BUILD/_buildManifest.js",
    ]) {
      expect(shouldPrecache({ url })).toBe(false);
    }
  });

  it("drops crawler text files", () => {
    expect(shouldPrecache({ url: "/llms-full.txt" })).toBe(false);
    expect(shouldPrecache("/robots.txt")).toBe(false);
  });

  it("filters a manifest without reordering it", () => {
    const manifest = [
      { url: "/_next/static/chunks/a.js", revision: null },
      { url: "/icon-512.png", revision: "x" },
      { url: "/_next/static/css/b.css", revision: null },
    ];
    expect(precacheEntries(manifest).map((e) => e.url)).toEqual([
      "/icon-512.png",
      "/_next/static/css/b.css",
    ]);
  });
});

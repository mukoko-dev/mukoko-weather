import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  BFCACHE_CACHE_CONTROL,
  BFCACHE_EXCLUDED_ROOTS,
  BFCACHE_HEADER_RULE,
  SESSION_COOKIE,
} from "./bfcache";

// The compiler Next.js itself uses for a headers() source (untyped).
const { pathToRegexp } = createRequire(import.meta.url)(
  "next/dist/compiled/path-to-regexp",
) as { pathToRegexp: (source: string) => RegExp };
const matches = (path: string) =>
  pathToRegexp(BFCACHE_HEADER_RULE.source).test(path);

describe("bfcache header rule", () => {
  it("answers no-cache, never no-store, so Back can restore the page", () => {
    expect(BFCACHE_CACHE_CONTROL).toBe("private, no-cache");
    expect(BFCACHE_CACHE_CONTROL).not.toMatch(/no-store/);
    expect(BFCACHE_HEADER_RULE.headers).toEqual([
      { key: "Cache-Control", value: "private, no-cache" },
    ]);
  });

  it("applies only when the AuthKit session cookie is absent", () => {
    expect(BFCACHE_HEADER_RULE.missing).toEqual([
      { type: "cookie", key: SESSION_COOKIE },
    ]);
    expect(SESSION_COOKIE).toBe("wos-session");
  });

  it("matches pages, including `/` and a place", () => {
    for (const path of [
      "/",
      "/about",
      "/explore/country/ZW",
      "/harare",
      "/harare/forecast",
      "/profile",
    ]) {
      expect(matches(path), path).toBe(true);
    }
  });

  it("never matches the excluded roots or files", () => {
    for (const root of BFCACHE_EXCLUDED_ROOTS) {
      expect(matches(`/${root}`), root).toBe(false);
      expect(matches(`/${root}/x`), root).toBe(false);
    }
    for (const path of [
      "/sw.js",
      "/manifest.json",
      "/favicon.ico",
      "/a/b.png",
    ]) {
      expect(matches(path), path).toBe(false);
    }
  });

  it("does not catch a place whose name merely starts like an excluded root", () => {
    expect(matches("/authority")).toBe(true);
    expect(matches("/apiary")).toBe(true);
  });
});

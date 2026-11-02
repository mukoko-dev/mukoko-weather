/**
 * The service worker's routes for the Worker's `/v1` data: what may be cached
 * and what may not. The source is read as text, as the other worker config tests
 * do, because the module registers listeners when it is imported.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "sw.ts"), "utf-8");

/** The runtimeCaching entry whose matcher mentions `needle`. */
function entry(needle: string): string {
  const at = source.indexOf(needle);
  expect(at, `${needle} has a route`).toBeGreaterThan(-1);
  const start = source.lastIndexOf("    {\n", at);
  const end = source.indexOf("\n    },", at);
  return source.slice(start, end);
}

describe("service worker routes for the Worker's data", () => {
  it("never caches /v1/history: a degraded no-store answer must not be served again after Retry", () => {
    const route = entry('startsWith("/v1/history")');
    expect(route).toContain("new NetworkOnly()");
    expect(route).not.toContain("NetworkFirst");
    expect(route).not.toContain("cacheName");
    expect(source).not.toContain('cacheName: "history-data"');
  });

  it("does not leave any Python path in the service worker", () => {
    expect(source).not.toContain("/api/py");
  });

  it("still serves the report list from the network first (GET only)", () => {
    const route = entry('startsWith("/v1/reports")');
    expect(route).toContain('request.method === "GET"');
    expect(route).toContain("new NetworkFirst");
    // The writes (submit, upvote) are POSTs and never matched.
    expect(route).not.toContain('"POST"');
  });
});

describe("service worker: the app shell (issue #414)", () => {
  const nextConfig = readFileSync(
    resolve(__dirname, "../../next.config.ts"),
    "utf-8",
  );

  it("answers page navigations through handleNavigation, first in the route list", () => {
    const first = source.indexOf("runtimeCaching: [");
    const nav = source.indexOf('request.mode === "navigate"');
    expect(nav).toBeGreaterThan(first);
    // Before every other route, so nothing else can claim a navigation.
    expect(nav).toBeLessThan(source.indexOf('startsWith("/_next/static/")'));
    expect(source).toContain("handleNavigation(new URL(request.url), {");
    expect(source).toContain("fetchEvent.preloadResponse");
    expect(source).toContain("navigationPreload: true");
  });

  it("falls back to the precached /offline itself, not through Serwist's fallbacks option", () => {
    expect(source).toContain("serwist.matchPrecache(OFFLINE_URL)");
    expect(source).not.toMatch(/\bfallbacks:/);
  });

  it("precaches /offline without cookies and adds it to the manifest at build time", () => {
    expect(source).toContain('fetchOptions: { credentials: "omit" }');
    expect(nextConfig).toContain(
      'additionalPrecacheEntries: [{ url: "/offline", revision: randomUUID() }]',
    );
  });

  it("names the page cache by build version and deletes other builds' caches on activate", () => {
    expect(source).toContain("versionOfManifest(MANIFEST)");
    // @serwist/next rejects a second reference to the injection point.
    expect(source.match(/self\.__SW_MANIFEST/g)).toHaveLength(1);
    expect(source).toContain("pagesCacheName(BUILD_VERSION)");
    expect(source).toContain('"activate"');
    expect(source).toContain("stalePagesCaches(names, BUILD_VERSION)");
  });

  it("updates cleanly: a new worker takes over at once", () => {
    expect(source).toContain("skipWaiting: true");
    expect(source).toContain("clientsClaim: true");
    const updater = readFileSync(
      resolve(__dirname, "../components/pwa/ServiceWorkerUpdater.tsx"),
      "utf-8",
    );
    expect(updater).toContain("hadControllerAtLoad");
  });

  it("keeps the last good weather payload and never caches personal endpoints", () => {
    expect(entry('startsWith("/v1/weather")')).toContain("new NetworkFirst");
    for (const needle of [
      'startsWith("/api/ai")',
      'startsWith("/v1/devices")',
    ]) {
      const route = entry(needle);
      expect(route).toContain("new NetworkOnly()");
      expect(route).not.toContain("cacheName");
    }
    // /api/keys, /auth, /profile are navigations or same-origin API calls the
    // worker has no caching route for at all.
    for (const never of ["/api/keys", '"/auth', '"/profile', "/callback"]) {
      expect(source).not.toContain(`startsWith(${never}`);
    }
  });
});

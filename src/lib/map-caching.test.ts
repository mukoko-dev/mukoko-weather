/**
 * Caching rules that decide how fast the map loads on a repeat visit and
 * whether a stale or empty radar frame can stick (#266). Structural: the
 * service worker and Next config only run in a browser / at build.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const root = resolve(__dirname, "../..");
const sw = readFileSync(resolve(root, "src/app/sw.ts"), "utf-8");
const nextConfig = readFileSync(resolve(root, "next.config.ts"), "utf-8");

describe("service worker map-tile caching", () => {
  it("never stores the proxy's transparent fallback tiles", () => {
    expect(sw).toContain('!response.headers.has("X-Map-Tile")');
    expect(sw).toContain("response.status === 200");
    // Nor an outdated tile served during an upstream outage.
    expect(sw).toContain('response.headers.get("X-Cache") !== "STALE"');
  });

  it("caches fixed-hour tiles CacheFirst but 'now' tiles NetworkFirst", () => {
    const fixed = sw.indexOf('url.searchParams.has("timestamp")');
    const nowRule = sw.indexOf('cacheName: "map-tiles-now"');
    expect(fixed).toBeGreaterThan(-1);
    expect(nowRule).toBeGreaterThan(fixed);
    const nowBlock = sw.slice(fixed, nowRule);
    expect(nowBlock).toContain("new NetworkFirst({");
    // Both tile rules use the fallback filter.
    expect(sw.split("skipFallbackTiles,").length - 1).toBe(2);
  });

  it("keeps a 'now' tile at most an hour", () => {
    const nowBlock = sw.slice(sw.indexOf('cacheName: "map-tiles-now"'));
    expect(nowBlock).toContain("maxAgeSeconds: 60 * 60");
  });
});

describe("MapLibre worker caching", () => {
  it("serves the versioned worker folder as immutable", () => {
    const i = nextConfig.indexOf('source: "/vendor/maplibre-gl/:path*"');
    expect(i).toBeGreaterThan(-1);
    expect(nextConfig.slice(i, i + 300)).toContain(
      "public, max-age=31536000, immutable",
    );
  });
});

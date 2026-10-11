/**
 * Service worker for mukoko weather — powered by Serwist.
 *
 * Caching strategies:
 *   - Static assets (_next/static): CacheFirst (content-hashed, immutable)
 *   - HTML pages: precached by Serwist; offline fallback via `fallbacks` config
 *   - Weather API: NetworkFirst (5s timeout, 15min cache)
 *   - Suitability/activities: StaleWhileRevalidate (1h cache)
 *   - Map tiles for a fixed forecast hour: CacheFirst (3h cache)
 *   - "Now" map tiles: NetworkFirst (the same URL is a new frame every hour)
 *   - Transparent fallback map tiles (X-Map-Tile header): never cached
 *   - AI/chat endpoints: NetworkOnly (personalized, never cached)
 */

import {
  Serwist,
  CacheFirst,
  NetworkFirst,
  StaleWhileRevalidate,
  NetworkOnly,
  ExpirationPlugin,
} from "serwist";
import type { PrecacheEntry } from "serwist";

/**
 * Only fresh overlay tiles may be stored. The proxy marks its transparent
 * fallback (quota spent, upstream error) with an `X-Map-Tile` header and an
 * outdated tile served during an outage with `X-Cache: STALE`; caching
 * one CacheFirst would hide the radar on this device long after the quota
 * reset (#266). Replacing `cacheWillUpdate` drops the default 200-only check,
 * so it is repeated here.
 */
const skipFallbackTiles = {
  cacheWillUpdate: async ({ response }: { response: Response }) =>
    response.status === 200 &&
    !response.headers.has("X-Map-Tile") &&
    response.headers.get("X-Cache") !== "STALE"
      ? response
      : null,
};

declare const self: {
  __SW_MANIFEST: Array<PrecacheEntry | string>;
} & Record<string, unknown>;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  precacheOptions: {
    cleanupOutdatedCaches: true,
    concurrency: 10,
  },
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  disableDevLogs: true,

  fallbacks: {
    entries: [
      {
        url: "/offline",
        matcher({ request }) {
          return request.destination === "document";
        },
      },
    ],
  },

  runtimeCaching: [
    // Static assets — CacheFirst (immutable, content-hashed by Next.js)
    {
      matcher: ({ url }) => url.pathname.startsWith("/_next/static/"),
      handler: new CacheFirst({
        cacheName: "static-assets",
        plugins: [
          new ExpirationPlugin({
            maxEntries: 200,
            maxAgeSeconds: 365 * 24 * 60 * 60,
          }),
        ],
      }),
    },

    // Weather API — NetworkFirst (15min cache for offline)
    {
      matcher: ({ url }) => url.pathname.startsWith("/api/py/weather"),
      handler: new NetworkFirst({
        cacheName: "weather-api",
        networkTimeoutSeconds: 5,
        plugins: [
          new ExpirationPlugin({
            maxEntries: 30,
            maxAgeSeconds: 15 * 60,
          }),
        ],
      }),
    },

    // Reference data — StaleWhileRevalidate (rules, activities, tags, prompts).
    // Phase 1D: AI prompts/rules now flow through /api/ai/* (auth-gated proxy).
    {
      matcher: ({ url }) =>
        url.pathname.startsWith("/api/py/suitability") ||
        url.pathname.startsWith("/api/py/activities") ||
        url.pathname.startsWith("/api/py/tags") ||
        url.pathname.startsWith("/api/ai/prompts") ||
        url.pathname.startsWith("/api/ai/suggested-rules"),
      handler: new StaleWhileRevalidate({
        cacheName: "reference-data",
        plugins: [
          new ExpirationPlugin({
            maxEntries: 20,
            maxAgeSeconds: 60 * 60,
          }),
        ],
      }),
    },

    // Location search — NetworkFirst (short cache for offline browsing)
    {
      matcher: ({ url }) =>
        url.pathname.startsWith("/api/py/search") ||
        url.pathname.startsWith("/api/py/locations") ||
        url.pathname.startsWith("/api/py/geo"),
      handler: new NetworkFirst({
        cacheName: "location-data",
        networkTimeoutSeconds: 3,
        plugins: [
          new ExpirationPlugin({
            maxEntries: 50,
            maxAgeSeconds: 30 * 60,
          }),
        ],
      }),
    },

    // Map tiles for a fixed forecast hour — CacheFirst: the URL names the
    // hour, so a stored tile stays right until the forecast is re-run.
    {
      matcher: ({ url }) =>
        url.pathname.startsWith("/api/py/map-tiles") &&
        url.searchParams.has("timestamp"),
      handler: new CacheFirst({
        cacheName: "map-tiles",
        plugins: [
          skipFallbackTiles,
          new ExpirationPlugin({
            maxEntries: 500,
            maxAgeSeconds: 3 * 60 * 60,
          }),
        ],
      }),
    },

    // "Now" map tiles — NetworkFirst: the URL carries no time, so a stored
    // copy is only an offline fallback, never served ahead of the network.
    {
      matcher: ({ url }) => url.pathname.startsWith("/api/py/map-tiles"),
      handler: new NetworkFirst({
        cacheName: "map-tiles-now",
        networkTimeoutSeconds: 6,
        plugins: [
          skipFallbackTiles,
          new ExpirationPlugin({
            maxEntries: 200,
            maxAgeSeconds: 60 * 60,
          }),
        ],
      }),
    },

    // History data — NetworkFirst (offline browsing)
    {
      matcher: ({ url }) => url.pathname.startsWith("/api/py/history"),
      handler: new NetworkFirst({
        cacheName: "history-data",
        networkTimeoutSeconds: 5,
        plugins: [
          new ExpirationPlugin({
            maxEntries: 20,
            maxAgeSeconds: 60 * 60,
          }),
        ],
      }),
    },

    // Community reports (GET) — NetworkFirst
    {
      matcher: ({ url, request }) =>
        url.pathname.startsWith("/api/py/reports") && request.method === "GET",
      handler: new NetworkFirst({
        cacheName: "reports-data",
        networkTimeoutSeconds: 3,
        plugins: [
          new ExpirationPlugin({
            maxEntries: 30,
            maxAgeSeconds: 30 * 60,
          }),
        ],
      }),
    },

    // AI endpoints — NetworkOnly (personalized, never cached). Both the
    // direct Python paths (legacy/internal) and the new auth-gated
    // /api/ai/* proxy are matched so a stale SW never traps a request.
    {
      matcher: ({ url }) =>
        url.pathname.startsWith("/api/py/ai") ||
        url.pathname.startsWith("/api/ai") ||
        url.pathname.startsWith("/api/py/chat") ||
        url.pathname.startsWith("/api/py/explore/search"),
      handler: new NetworkOnly(),
    },

    // Device sync — NetworkOnly
    {
      matcher: ({ url }) => url.pathname.startsWith("/api/py/devices"),
      handler: new NetworkOnly(),
    },
  ],
});

serwist.addEventListeners();

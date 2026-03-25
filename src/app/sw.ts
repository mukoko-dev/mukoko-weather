/**
 * Service worker for mukoko weather — powered by Serwist.
 *
 * Caching strategies:
 *   - Static assets (_next/static): CacheFirst (content-hashed, immutable)
 *   - HTML pages: precached by Serwist; offline fallback via `fallbacks` config
 *   - Weather API: NetworkFirst (5s timeout, 15min cache)
 *   - Suitability/activities: StaleWhileRevalidate (1h cache)
 *   - Map tiles: CacheFirst (24h cache)
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

    // Reference data — StaleWhileRevalidate (rules, activities, tags, prompts)
    {
      matcher: ({ url }) =>
        url.pathname.startsWith("/api/py/suitability") ||
        url.pathname.startsWith("/api/py/activities") ||
        url.pathname.startsWith("/api/py/tags") ||
        url.pathname.startsWith("/api/py/ai/prompts") ||
        url.pathname.startsWith("/api/py/ai/suggested-rules"),
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

    // Map tiles — CacheFirst (expensive, stable data)
    {
      matcher: ({ url }) => url.pathname.startsWith("/api/py/map-tiles"),
      handler: new CacheFirst({
        cacheName: "map-tiles",
        plugins: [
          new ExpirationPlugin({
            maxEntries: 500,
            maxAgeSeconds: 24 * 60 * 60,
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

    // AI endpoints — NetworkOnly (personalized, never cached)
    {
      matcher: ({ url }) =>
        url.pathname.startsWith("/api/py/ai") ||
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

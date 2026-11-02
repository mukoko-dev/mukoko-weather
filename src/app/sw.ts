/**
 * Service worker for mukoko weather — powered by Serwist.
 *
 * Caching strategies:
 *   - Static assets (_next/static): CacheFirst (content-hashed, immutable)
 *   - Precache: stylesheets, public icons and the /offline shell only
 *     (src/lib/sw-precache.ts), so install never competes with the first
 *     paint for bandwidth. /offline is fetched without cookies.
 *   - Page navigations (src/lib/sw-navigation.ts): `/` and `/{slug}` that the
 *     server marked anonymous and cookie-free are stale-while-revalidate (the
 *     stored shell paints first, the network refreshes it); every other page
 *     is the network, then /offline. Nothing signed-in or personal is stored.
 *     Caches are named `pages-<build version>`; a new worker deletes the rest.
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
import { OFFLINE_URL, precacheEntries } from "@/lib/sw-precache";
import {
  handleNavigation,
  pagesCacheName,
  stalePagesCaches,
  versionOfManifest,
} from "@/lib/sw-navigation";

/** The slice of a `FetchEvent` the navigation handler uses (no webworker lib here). */
interface FetchEventLike {
  preloadResponse: Promise<Response | undefined>;
  waitUntil(work: Promise<unknown>): void;
}

/** The slice of an `ExtendableEvent` the activate handler uses. */
interface ActivateEventLike {
  waitUntil(work: Promise<unknown>): void;
}

declare const self: {
  __SW_MANIFEST: Array<PrecacheEntry | string>;
} & Record<string, unknown>;

// A version that changes whenever the build's emitted assets do: stored pages
// name this build's chunks, so another build's pages are never served.
// (The build's injection point may appear only once in this file.)
const MANIFEST = self.__SW_MANIFEST;
const BUILD_VERSION = versionOfManifest(MANIFEST);
const PAGES_CACHE = pagesCacheName(BUILD_VERSION);

const serwist: Serwist = new Serwist({
  // Only the offline shell is precached (src/lib/sw-precache.ts); chunks and
  // fonts are cached on first use by the CacheFirst route below.
  precacheEntries: precacheEntries(MANIFEST),
  precacheOptions: {
    cleanupOutdatedCaches: true,
    concurrency: 10,
    // Precache without cookies: /offline must never hold a visitor's name.
    fetchOptions: { credentials: "omit" },
  },
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  disableDevLogs: true,

  runtimeCaching: [
    // Page navigations: the app shell. See src/lib/sw-navigation.ts for what
    // may be stored and when a stored copy is dropped.
    {
      matcher: ({ request }) => request.mode === "navigate",
      handler: {
        async handle({ request, event }): Promise<Response> {
          const fetchEvent = event as unknown as FetchEventLike;
          const cache = await caches.open(PAGES_CACHE);
          return handleNavigation(new URL(request.url), {
            pages: {
              match: (key) => cache.match(key),
              put: (key, response) => cache.put(key, response),
              delete: (key) => cache.delete(key),
              keys: async () => (await cache.keys()).map((r) => r.url),
            },
            // The browser's navigation preload when it started one, else a
            // fetch. Used once per navigation.
            network: async () =>
              (await fetchEvent.preloadResponse) ?? fetch(request),
            offline: async (): Promise<Response | undefined> =>
              serwist.matchPrecache(OFFLINE_URL),
            clearPages: async () => {
              await caches.delete(PAGES_CACHE);
            },
            waitUntil: (work) => fetchEvent.waitUntil(work),
          });
        },
      },
    },

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

    // Weather API (the Rust Worker's /v1/weather) — NetworkFirst (15min cache
    // for offline)
    {
      matcher: ({ url }) => url.pathname.startsWith("/v1/weather"),
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
        url.pathname.startsWith("/v1/suitability") ||
        url.pathname.startsWith("/v1/activities") ||
        url.pathname.startsWith("/v1/tags") ||
        url.pathname.startsWith("/v1/ai/prompts") ||
        url.pathname.startsWith("/v1/ai/suggested-rules"),
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

    // Map tiles — CacheFirst (expensive, stable data)
    {
      matcher: ({ url }) => url.pathname.startsWith("/v1/map-tiles"),
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

    // History data — NetworkOnly. The Worker marks a degraded answer (a store
    // unreadable, a budget spent) `no-store` and the page offers a retry;
    // Workbox ignores Cache-Control, so a cached copy would be served again
    // after Retry. Only the Worker may decide what is complete.
    {
      matcher: ({ url }) => url.pathname.startsWith("/v1/history"),
      handler: new NetworkOnly(),
    },

    // Community reports (GET) — NetworkFirst
    {
      matcher: ({ url, request }) =>
        url.pathname.startsWith("/v1/reports") && request.method === "GET",
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

    // AI endpoints — NetworkOnly (personalized, never cached): the auth-gated
    // /api/ai/* proxy.
    {
      matcher: ({ url }) => url.pathname.startsWith("/api/ai"),
      handler: new NetworkOnly(),
    },

    // Device sync — NetworkOnly
    {
      matcher: ({ url }) => url.pathname.startsWith("/v1/devices"),
      handler: new NetworkOnly(),
    },
  ],
});

serwist.addEventListeners();

// A new build's worker drops the stored pages of every other build when it
// takes over (they name chunks the new build may not have).
(
  self as unknown as {
    addEventListener(
      type: "activate",
      listener: (event: ActivateEventLike) => void,
    ): void;
  }
).addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          stalePagesCaches(names, BUILD_VERSION).map((name) =>
            caches.delete(name),
          ),
        ),
      ),
  );
});

// Web push (mukoko-dev/mukoko-weather#289). Glue only: the logic is in
// src/lib/push/sw-logic.ts so it can move to another service-worker toolchain.
// Delivery is best effort; a browser requires a visible notification per push.
import {
  notificationFor,
  openFromClick,
  resubscribeAfterChange,
  showWithFallback,
  type ClientsLike,
} from "@/lib/push/sw-logic";

interface PushScope {
  addEventListener(type: string, listener: (event: any) => void): void; // eslint-disable-line @typescript-eslint/no-explicit-any
  registration: {
    showNotification(title: string, options: object): Promise<void>;
    pushManager: {
      subscribe(o: {
        userVisibleOnly: true;
        applicationServerKey: Uint8Array;
      }): Promise<{ toJSON(): unknown }>;
    };
  };
  clients: ClientsLike;
  location: { origin: string };
}
const pushScope = self as unknown as PushScope;

pushScope.addEventListener("push", (event) => {
  let raw: unknown;
  try {
    raw = event.data?.text();
  } catch {
    raw = undefined;
  }
  event.waitUntil(
    showWithFallback(pushScope.registration, notificationFor(raw)),
  );
});

pushScope.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    openFromClick(
      event.notification.data,
      pushScope.clients,
      pushScope.location.origin,
    ),
  );
});

pushScope.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    resubscribeAfterChange({
      registration: pushScope.registration,
      fetchFn: (i, o) => fetch(i, o),
    }),
  );
});

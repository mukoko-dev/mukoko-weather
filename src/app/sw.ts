/**
 * Service worker for mukoko weather — powered by Serwist.
 *
 * Caching strategies:
 *   - Static assets (_next/static): CacheFirst (content-hashed, immutable)
 *   - Precache: stylesheets, public icons and the /offline shell only
 *     (src/lib/sw-precache.ts), so install never competes with the first
 *     paint for bandwidth. /offline is fetched without cookies.
 *   - The /offline page's own scripts: at install the worker reads them out
 *     of the precached /offline HTML and stores each in `static-assets`
 *     (src/lib/sw-shell.ts), so the page can start with no network. A pass
 *     that stored everything is not repeated; one that did not is tried again
 *     on a later navigation. Best effort: it never fails the install.
 *   - Page navigations (src/lib/sw-navigation.ts): `/` and `/{slug}` that the
 *     server marked anonymous and cookie-free are stale-while-revalidate (the
 *     stored shell paints first, the network refreshes it); every other page
 *     is the network, then /offline. Nothing signed-in or personal is stored.
 *     Caches are named `pages-<build version>`; a new worker deletes the rest.
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
import { OFFLINE_URL, precacheEntries } from "@/lib/sw-precache";
import {
  SHELL_INSTALL_TIMEOUT_MS,
  STATIC_ASSETS_CACHE,
  boundedBy,
  createShellKeeper,
  isStorableStaticAsset,
  warmShellAssets,
} from "@/lib/sw-shell";
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

/** The slice of an `InstallEvent` / `FetchEvent` a shell pass runs inside. */
type ShellEvent = ActivateEventLike;

/** The slice of the worker's global scope the shell pass uses. */
interface ShellScope {
  location: { origin: string };
  navigator: { onLine: boolean };
  addEventListener(
    type: "install",
    listener: (event: ShellEvent) => void,
  ): void;
}

/**
 * Only fresh overlay tiles may be stored. The tiles Worker marks its
 * transparent fallback (quota spent, upstream error) with an `X-Map-Tile`
 * header and an outdated tile served during an outage with `X-Cache: STALE`;
 * caching one CacheFirst would hide the radar on this device long after the
 * quota reset (#266). The Worker is on another origin, so the worker script
 * can read these two headers only because the Worker lists them in
 * `Access-Control-Expose-Headers` (workers/tiles/src/lib.rs; pinned by
 * src/lib/map-caching.test.ts). Replacing `cacheWillUpdate` drops the default
 * 200-only check, so it is repeated here.
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

// A version that changes whenever the build's emitted assets do: stored pages
// name this build's chunks, so another build's pages are never served.
// (The build's injection point may appear only once in this file.)
const MANIFEST = self.__SW_MANIFEST;
const BUILD_VERSION = versionOfManifest(MANIFEST);
const PAGES_CACHE = pagesCacheName(BUILD_VERSION);

// The `/_next/static/` route's strategy. Hoisted because the /offline page's
// own scripts are stored through it too (see "The /offline page can start"
// below), so they are tracked and expired exactly like a file cached on use.
const staticAssets = new CacheFirst({
  cacheName: STATIC_ASSETS_CACHE,
  plugins: [
    // Never keep a page's HTML under a script's URL (see isStorableStaticAsset).
    {
      cacheWillUpdate: async ({ response }) =>
        isStorableStaticAsset(response) ? response : null,
    },
    new ExpirationPlugin({
      // The /offline page's own files (about 35) live here too: headroom over
      // the old 200, so a visitor who opens many pages online does not push
      // them out (a pass repairs that on the next navigation, but only online).
      maxEntries: 250,
      maxAgeSeconds: 365 * 24 * 60 * 60,
    }),
  ],
});

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
          // A pass that did not store everything is tried again here, in the
          // background (the page does not wait for it), while there is a
          // network to try it on.
          if (shellScope.navigator.onLine !== false) {
            const again = shellKeeper.retry(fetchEvent);
            if (again) fetchEvent.waitUntil(again);
          }
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
      handler: staticAssets,
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

    // Map tiles for a fixed forecast hour — CacheFirst: the URL names the
    // hour, so a stored tile stays right until the forecast is re-run. The
    // tiles Worker lives on its own origin (weather-tiles.mukoko.com), so this
    // matches on the path alone, as the /v1/weather route does.
    {
      matcher: ({ url }) =>
        url.pathname.startsWith("/v1/map-tiles") &&
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
      matcher: ({ url }) => url.pathname.startsWith("/v1/map-tiles"),
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

// ── The /offline page can start with no network ─────────────────────────────
// The precache holds the /offline HTML; the page's scripts are what let React
// start. They are read out of that HTML (never a hard-coded name) and stored
// in `static-assets`, so the page is complete offline even when the visitor
// never opened it online. Best effort throughout: nothing here fails the
// install, and a pass that stored less than everything is repeated on a later
// navigation. The decisions are in src/lib/sw-shell.ts.
const shellScope = self as unknown as ShellScope;

/**
 * Only the ability to keep the worker alive for a while: nothing else of
 * `event`. Once the event is over (the install bound passed while files were
 * still coming) `waitUntil` throws; the work simply carries on for as long as
 * the worker lives, and a pass it could not finish is repeated from a
 * navigation, so the files still to come are not failed for it.
 */
const lifetimeOf = (event: ShellEvent): ShellEvent => ({
  waitUntil: (work) => {
    try {
      event.waitUntil(work);
    } catch {
      /* the event has ended */
    }
  },
});
const OFFLINE_PAGE_URL = new URL(OFFLINE_URL, shellScope.location.origin).href;

const shellKeeper = createShellKeeper<ShellEvent>({
  now: () => Date.now(),
  warm: (event) =>
    warmShellAssets({
      pageUrl: OFFLINE_PAGE_URL,
      // The copy just precached when it is there, else the network's: either
      // is this build's /offline, fetched without cookies like the precache.
      page: async () =>
        (await serwist.matchPrecache(OFFLINE_URL)) ??
        fetch(OFFLINE_URL, { credentials: "omit" }),
      // A plain lookup in every cache first (the precache holds the
      // stylesheets): a pass runs on the first navigation of every worker
      // start and must not touch the network or the expiry bookkeeping for
      // files that are there. An entry that is not a usable file (a page's
      // HTML stored under a script's URL by a worker from before the guard
      // above) does not count as stored.
      has: async (url) => {
        const held = await caches.match(url);
        return !!held && isStorableStaticAsset(held);
      },
      // A missing one goes through the route's own strategy: fetched, stored
      // and counted for expiry like any file cached on use.
      // The strategy gets a stand-in that only extends the worker's lifetime,
      // NEVER the event itself: given a navigation's FetchEvent, Serwist
      // answers every fetch made under it with that navigation's preload
      // response (the page's HTML), which would be stored under the script's
      // URL. (Found by the real-browser check of the retry.)
      load: async (url) => {
        // The strategy answers from the cache first: drop a bad entry so it
        // is fetched again rather than served again.
        const cache = await caches.open(STATIC_ASSETS_CACHE);
        const held = await cache.match(url);
        if (held && !isStorableStaticAsset(held)) await cache.delete(url);
        const response = await staticAssets.handle({
          request: new Request(url, { credentials: "omit" }),
          event: lifetimeOf(event) as never,
        });
        return response.ok && isStorableStaticAsset(response);
      },
    }),
});

shellScope.addEventListener("install", (event) => {
  // Held open for the pass, but never for long, and never rejecting: a
  // stalled connection must not hold an install (and the update) hostage.
  event.waitUntil(
    boundedBy(shellKeeper.ensure(event), SHELL_INSTALL_TIMEOUT_MS),
  );
});

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

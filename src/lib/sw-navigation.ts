/**
 * How the service worker answers a page navigation (opening the installed
 * app, a reload, a link from outside). The worker's glue is `src/app/sw.ts`;
 * every decision is here, pure and injected, so it is tested without a
 * browser.
 *
 * The page HTML is the app shell. Since the server stopped fetching weather
 * (issue #414) it carries the header, the bottom nav, the skeleton and the
 * place — no forecast — so a copy of it is safe to show first and refresh in
 * the background; the forecast is the visitor's own request, painted over the
 * copy stored on the device.
 *
 * What may be cached (the owner's rule: nothing authenticated or personal,
 * nothing that sets a cookie):
 * - only `GET` navigations to `/` and `/{slug}` (`isPlacePath`, which must agree
 *   with `placeTargetOf`; a test pins it): never `/profile`, `/auth/*`,
 *   `/callback`, `/api/*`, a sub-route, or a path with anything else on it;
 * - only a 200 HTML response the SERVER marked `x-mukoko-shell: anonymous`.
 *   The edge proxy (`src/proxy.ts`) sets it only when no one is signed in and
 *   the response sets no cookie. A service worker cannot see `Set-Cookie` or
 *   the session cookie, so it cannot decide this itself;
 * - a signed-in visitor's responses are never marked, so they are never
 *   stored and always come from the network.
 *
 * A stored copy never outlives the situation it was stored in:
 * - a navigation to `/callback` or `/auth/*` (signing in or out) drops every
 *   stored page, so the first page after either is fetched fresh;
 * - the background refresh deletes the copy when the fresh answer is a 404,
 *   a redirect, or a signed-in page;
 * - the cache name carries the build's version, and a new worker deletes the
 *   caches of every other version when it activates, so a deploy never serves
 *   HTML that names chunks the new build no longer has.
 */

/** Response header the edge proxy sets on a page that is safe to keep. */
export const SHELL_HEADER = "x-mukoko-shell";
/** Its only value. */
export const SHELL_ANONYMOUS = "anonymous";

/** Cache names for stored pages: `pages-<build version>`. */
export const PAGES_CACHE_PREFIX = "pages-";

/**
 * Most place pages kept at once. Each is a few tens of KB of HTML; the oldest
 * go first, so a visitor who browses many places never fills the device.
 */
export const MAX_STORED_PAGES = 12;

/**
 * Top-level routes that are not places. A copy of NON_LOCATION_ROUTES
 * (src/lib/current-slug.ts) and the proxy's KNOWN_ROUTES, kept here because the
 * worker must not import them: that module pulls the whole location catalogue
 * into sw.js. `sw-navigation.test.ts` fails if either list grows without this.
 */
export const RESERVED_ROUTES: ReadonlySet<string> = new Set([
  "explore",
  "locations",
  "shamwari",
  "history",
  "aviation",
  "about",
  "help",
  "privacy",
  "terms",
  "status",
  "embed",
  "offline",
  "api",
  "auth",
  "callback",
  "profile",
  "developers",
  "releases",
  "login",
  "signage",
  "display",
]);

/** A location slug: the app's `LOCATION_SLUG_RE`. */
const SLUG_RE = /^[a-z0-9-]{1,80}$/;

/** True for `/` and for `/{slug}` exactly (one segment, not a route name). */
export function isPlacePath(pathname: string): boolean {
  const path =
    pathname.length > 1 && pathname.endsWith("/")
      ? pathname.slice(0, -1)
      : pathname;
  if (path === "/") return true;
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 1 || path !== `/${parts[0]}`) return false;
  let slug: string;
  try {
    slug = decodeURIComponent(parts[0]);
  } catch {
    return false;
  }
  return SLUG_RE.test(slug) && !RESERVED_ROUTES.has(slug);
}

export function pagesCacheName(version: string): string {
  return `${PAGES_CACHE_PREFIX}${version}`;
}

/** Page caches that belong to another build, to delete on activate. */
export function stalePagesCaches(
  names: readonly string[],
  currentVersion: string,
): string[] {
  const current = pagesCacheName(currentVersion);
  return names.filter(
    (name) => name.startsWith(PAGES_CACHE_PREFIX) && name !== current,
  );
}

/**
 * A short stable version for a precache manifest: it changes whenever any
 * asset the build emits changes (FNV-1a over the entries, base 36).
 */
export function versionOfManifest(
  manifest: ReadonlyArray<string | { url: string; revision?: string | null }>,
): string {
  let hash = 0x811c9dc5;
  const feed = (text: string) => {
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  };
  for (const entry of manifest) {
    if (typeof entry === "string") feed(entry);
    else {
      feed(entry.url);
      feed(entry.revision ?? "");
    }
    feed("\n");
  }
  return hash.toString(36);
}

export type NavigationKind = "shell" | "auth" | "other";

/**
 * `shell`: a page the worker may serve from its copy. `auth`: signing in or
 * out, which drops every copy. `other`: network first, offline shell as the
 * fallback.
 */
export function classifyNavigation(url: URL): NavigationKind {
  const path = url.pathname;
  if (path === "/callback" || path === "/auth" || path.startsWith("/auth/")) {
    return "auth";
  }
  return isPlacePath(path) ? "shell" : "other";
}

/** The key a page is stored under: the path, never the query or the hash. */
export function pageKey(url: URL): string {
  const path =
    url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
  return `${url.origin}${path}`;
}

/** True for a response the server marked safe to keep (see the module comment). */
export function isShellResponse(res: Response): boolean {
  return (
    res.status === 200 &&
    res.type !== "opaque" &&
    res.type !== "opaqueredirect" &&
    res.headers.get(SHELL_HEADER) === SHELL_ANONYMOUS &&
    (res.headers.get("content-type") ?? "").includes("text/html") &&
    !res.headers.has("set-cookie")
  );
}

/** A stored copy that a fresh answer says is wrong, and must go. */
function invalidates(res: Response): boolean {
  if (res.type === "opaqueredirect") return true;
  if (res.status === 404 || res.status === 410) return true;
  if (res.status >= 300 && res.status < 400) return true;
  // A page that loaded fine but is not anonymous: someone signed in.
  return res.status === 200 && !isShellResponse(res);
}

export interface PagesCache {
  match(key: string): Promise<Response | undefined>;
  put(key: string, response: Response): Promise<void>;
  delete(key: string): Promise<boolean>;
  /** Stored keys, oldest first (a `Cache` lists in insertion order). */
  keys(): Promise<string[]>;
}

export interface NavigationDeps {
  pages: PagesCache;
  /** This navigation from the network (the preload response, else a fetch). */
  network(): Promise<Response | undefined>;
  /** The precached offline page. */
  offline(): Promise<Response | undefined>;
  /** Delete every stored page (the visitor is signing in or out). */
  clearPages(): Promise<void>;
  /** Keep the worker alive for background work. */
  waitUntil(work: Promise<unknown>): void;
}

/**
 * The network, then the offline shell only if the network FAILED. A slow
 * network is not an offline one: the visitor waits for the page like they
 * would without a worker, never gets "You're offline" while connected.
 */
async function networkOrOffline(deps: NavigationDeps): Promise<Response> {
  const res = await deps.network().catch(() => undefined);
  if (res) return res;
  return (await deps.offline()) ?? Response.error();
}

/** Keep at most `max` stored pages, dropping the oldest. */
export async function trimPages(
  pages: PagesCache,
  max: number = MAX_STORED_PAGES,
): Promise<void> {
  try {
    const keys = await pages.keys();
    for (const key of keys.slice(0, Math.max(0, keys.length - max))) {
      await pages.delete(key);
    }
  } catch {
    // Housekeeping only.
  }
}

/** Refresh a stored page in the background; drop it when it is no longer right. */
async function revalidate(key: string, deps: NavigationDeps): Promise<void> {
  try {
    const res = await deps.network();
    if (!res) return;
    if (isShellResponse(res)) {
      await deps.pages.put(key, res);
      await trimPages(deps.pages);
    } else if (invalidates(res)) await deps.pages.delete(key);
    // A 5xx or a network failure keeps the copy we have.
  } catch {
    // Offline: the copy stays.
  }
}

/** The response for one navigation. Never rejects. */
export async function handleNavigation(
  url: URL,
  deps: NavigationDeps,
): Promise<Response> {
  try {
    const kind = classifyNavigation(url);

    if (kind === "auth") {
      deps.waitUntil(deps.clearPages().catch(() => undefined));
      return await networkOrOffline(deps);
    }

    if (kind === "shell") {
      const key = pageKey(url);
      const stored = await deps.pages.match(key).catch(() => undefined);
      if (stored) {
        // Stale-while-revalidate: the copy paints now, the network refreshes
        // it for the next open.
        deps.waitUntil(revalidate(key, deps));
        return stored;
      }
      const res = await deps.network().catch(() => undefined);
      if (!res) return (await deps.offline()) ?? Response.error();
      if (isShellResponse(res)) {
        // Cloned before the browser reads the body.
        deps.waitUntil(
          deps.pages
            .put(key, res.clone())
            .then(() => trimPages(deps.pages))
            .catch(() => undefined),
        );
      }
      return res;
    }

    return await networkOrOffline(deps);
  } catch {
    return (await deps.offline().catch(() => undefined)) ?? Response.error();
  }
}

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
 * - only `GET` navigations to `/` and `/{slug}` (`placeTargetOf`): never
 *   `/profile`, `/auth/*`, `/callback`, `/api/*`, a sub-route, or a path with
 *   anything else on it;
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

import { placeTargetOf } from "./place-target";

/** Response header the edge proxy sets on a page that is safe to keep. */
export const SHELL_HEADER = "x-mukoko-shell";
/** Its only value. */
export const SHELL_ANONYMOUS = "anonymous";

/** Cache names for stored pages: `pages-<build version>`. */
export const PAGES_CACHE_PREFIX = "pages-";

/** Longest an uncached navigation waits for the network before the offline shell. */
export const NAVIGATION_TIMEOUT_MS = 8_000;

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
  return placeTargetOf(path) ? "shell" : "other";
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
  /** Overridable for tests. */
  timeoutMs?: number;
}

async function networkWithin(
  deps: NavigationDeps,
): Promise<Response | undefined> {
  const limit = deps.timeoutMs ?? NAVIGATION_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), limit);
  });
  try {
    return await Promise.race([deps.network().catch(() => undefined), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function networkOrOffline(deps: NavigationDeps): Promise<Response> {
  const res = await networkWithin(deps);
  if (res) return res;
  return (await deps.offline()) ?? Response.error();
}

/** Refresh a stored page in the background; drop it when it is no longer right. */
async function revalidate(key: string, deps: NavigationDeps): Promise<void> {
  try {
    const res = await deps.network();
    if (!res) return;
    if (isShellResponse(res)) await deps.pages.put(key, res);
    else if (invalidates(res)) await deps.pages.delete(key);
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
      const res = await networkWithin(deps);
      if (!res) return (await deps.offline()) ?? Response.error();
      if (isShellResponse(res)) {
        // Cloned before the browser reads the body.
        deps.waitUntil(deps.pages.put(key, res.clone()).catch(() => undefined));
      }
      return res;
    }

    return await networkOrOffline(deps);
  } catch {
    return (await deps.offline().catch(() => undefined)) ?? Response.error();
  }
}

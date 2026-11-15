/**
 * Back/forward cache (bfcache) eligibility for the pages the app serves.
 *
 * Every page here is rendered per request (the root layout reads the AuthKit
 * session), and Next.js answers such a page with
 * `Cache-Control: private, no-cache, no-store, max-age=0, must-revalidate`.
 * Chrome reports the `no-store` as `response-cache-control-no-store` (and
 * `...-with-js-network-request`) and keeps the page out of the back/forward
 * cache: pressing Back reloads and re-renders the page it left instead of
 * restoring it as it was, scroll position and open sheet included.
 *
 * The modern-web-guidance `performance` guide: do not use `no-store` for
 * non-sensitive resources, because it keeps the page out of the bfcache; use
 * `no-cache` for a page that only has to be fresh.
 *
 * `no-store` is right for a page that holds a person: a signed-in visitor's
 * page names them, and Back after signing out must not show it. So only a
 * request that carries NO AuthKit session cookie is answered
 * `private, no-cache` (still never shared by a cache, and still revalidated on
 * a normal load); a visitor with a session keeps what Next.js sends. A header
 * set from the proxy does not work for this: Next.js replaces it, but it
 * leaves one set in `next.config.ts` `headers()` alone (send-payload.js: "If
 * cache control is already set on the response we don't override it to allow
 * users to customize it via next.config"), and `missing` can name the cookie.
 */

/** What an anonymous page answers instead of Next.js's `no-store`. */
export const BFCACHE_CACHE_CONTROL = "private, no-cache";

/** The AuthKit session cookie (the library's default name, `wos-session`). */
export const SESSION_COOKIE = "wos-session";

/**
 * Top-level routes that keep what Next.js sends: the sign-in/out and callback
 * handlers (they redirect and set the session), the API, and the two surfaces
 * that are not read as a back-and-forth page (a kiosk that refreshes itself,
 * and the widget inside somebody else's page). Static folders are listed so a
 * dot-less request under them is never matched.
 */
export const BFCACHE_EXCLUDED_ROOTS: readonly string[] = [
  "api",
  "auth",
  "callback",
  "login",
  "display",
  "embed",
  "signage",
  "_next",
  "icons",
  "vendor",
];

/**
 * The `headers()` rule for `next.config.ts`. A path with a dot is a file
 * (`/sw.js`, `/manifest.json`, `/favicon.ico`) and has its own rules, so it is
 * never matched, exactly as the proxy's matcher treats it.
 */
export const BFCACHE_HEADER_RULE = {
  source: `/((?!(?:${BFCACHE_EXCLUDED_ROOTS.join("|")})(?:/|$)|.*\\..*).*)`,
  missing: [{ type: "cookie" as const, key: SESSION_COOKIE }],
  headers: [{ key: "Cache-Control", value: BFCACHE_CACHE_CONTROL }],
};

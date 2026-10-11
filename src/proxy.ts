import { NextFetchEvent, NextRequest, NextResponse } from "next/server";
import { authkit, handleAuthkitProxy } from "@workos-inc/authkit-nextjs";
import {
  LOCATION_NOT_FOUND_REWRITE,
  LOCATION_SLUG_RE,
  classifyLocationPath,
  isRenderableLocation,
} from "@/lib/location-gate";
import { resolveLocationSlug } from "@/lib/places";

/** Read by the home page (src/app/page.tsx) as its fallback location. */
const LAST_LOCATION_COOKIE = "lastLocation";

/** The gate needs DB errors to throw, not to read as "not found". */
const strictResolve = (slug: string) =>
  resolveLocationSlug(slug, { strict: true });

/**
 * Top-level routes that are NOT location slugs. Every directory under
 * src/app (other than [location]) must be listed — src/proxy.test.ts fails
 * when one is missing. WeatherLoadingScene keeps the page-route subset.
 */
const KNOWN_ROUTES = new Set([
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
  "display",
  "offline",
  "profile",
  "developers",
  "api",
  // WorkOS AuthKit routes — never confuse with location slugs
  "auth",
  "callback",
]);

/**
 * Edge middleware — WorkOS AuthKit session refresh + lastLocation cookie bookkeeping.
 *
 * Two responsibilities:
 * 1. Refresh the WorkOS session via `authkit(request)` — runs every request
 *    so `withAuth()` on the server side always sees a fresh session.
 * 2. Location pages (GET /{slug}/*): set the lastLocation cookie on the
 *    response so the home page has a cached fallback location to show.
 *
 * NOTE: the home page (GET /) is deliberately NOT redirected here. Device GPS
 * only exists in the browser — the edge has no way to check whether a
 * returning visitor has travelled since their last visit. An instant
 * edge redirect straight to the cached lastLocation would skip that check
 * entirely and strand travelers on their old city every time they open the
 * app. That GPS refresh happens client-side instead, in
 * CurrentLocationHome's mount effect — see src/app/CurrentLocationHome.tsx.
 */
export default async function proxy(
  request: NextRequest,
  event?: NextFetchEvent,
) {
  const { pathname } = request.nextUrl;

  // Always refresh the AuthKit session first so subsequent withAuth() reads
  // are fresh. The returned headers must be merged onto every outbound
  // response via handleAuthkitProxy.
  //
  // The location gate (below) doesn't depend on the session, so its lookup
  // runs alongside the refresh instead of after it.
  const path = classifyLocationPath(pathname, KNOWN_ROUTES);
  const [{ headers }, renderable] = await Promise.all([
    authkit(request),
    path.kind === "slug"
      ? isRenderableLocation(path.slug, strictResolve, {
          // A lookup that outlives the timeout keeps running after the
          // response, so it can still cache its answer.
          keepAlive: (pending) => event?.waitUntil(pending),
        })
      : Promise.resolve(null),
  ]);

  // ── Unknown location slug → real 404 with a server-rendered page (#263) ──
  // A notFound() thrown while the page renders gives a 404 with an EMPTY
  // server HTML body in Next 16 (the not-found page only appears after
  // hydration). Rewriting to an unmatched internal path makes Next render
  // the root not-found page on the server, with a 404, like any unknown URL.
  // A failed lookup (null) lets the request through to the page as before.
  //
  // Cost: seed slugs and smart-slug spots (almost all traffic) pass with no
  // lookup. Other slugs are looked up here AND again by the page, because a
  // proxy result can't be handed to the render; positive answers are cached
  // per instance for 10 minutes to keep that second lookup the only one.
  //
  // A slug in the wrong case (`/Harare`) is redirected to its lowercase,
  // canonical URL rather than 404'd: it used to render through the
  // resolver's case-insensitive name lookup.
  if (path.kind === "redirect") {
    return handleAuthkitProxy(request, headers, {
      redirect: new URL(path.location + request.nextUrl.search, request.url),
      redirectStatus: 308,
    });
  }
  const unknownLocation = path.kind === "unknown" || renderable === false;

  // ── Default response with AuthKit session cookies attached ───────────────
  const response = unknownLocation
    ? rewriteWithAuthkit(request, headers, LOCATION_NOT_FOUND_REWRITE)
    : handleAuthkitProxy(request, headers);

  // ── Location pages: persist slug in cookie (30 days) ────────────────────
  // Only the first path segment — sub-routes like /harare/forecast set "harare".
  // Deliberately still set for a slug the gate just 404'd: whether a 404 slug
  // may overwrite the cookie is an open owner decision (#238).
  const slug = pathname.slice(1).split("/")[0];
  if (slug && LOCATION_SLUG_RE.test(slug) && !KNOWN_ROUTES.has(slug)) {
    // `response.cookies` was built before AuthKit's Set-Cookie headers were
    // applied, and setting through it rewrites the whole header from its own
    // copy, dropping a refreshed session cookie. So set it (Next's cookie
    // bookkeeping included), then put back whatever AuthKit had sent.
    const authkitCookies = response.headers.getSetCookie();
    response.cookies.set(LAST_LOCATION_COOKIE, slug, {
      maxAge: 2592000,
      path: "/",
      sameSite: "lax",
    });
    const kept = new Set(response.headers.getSetCookie());
    for (const cookie of authkitCookies) {
      if (!kept.has(cookie)) response.headers.append("set-cookie", cookie);
    }
  }

  return response;
}

/**
 * `handleAuthkitProxy` only builds `next()` and redirect responses. A rewrite
 * takes its output as is (session cookies, the forwarded request headers,
 * and its own PKCE cookie handling) and swaps the `next()` marker for the
 * rewrite. Nothing about AuthKit's headers is re-implemented here, so this
 * path can't drift from every other proxy response.
 */
function rewriteWithAuthkit(
  request: NextRequest,
  authkitHeaders: Headers,
  path: string,
): NextResponse {
  const base = handleAuthkitProxy(request, authkitHeaders);
  // Only a `next()` can become a rewrite; anything else (a redirect AuthKit
  // decided on) goes out unchanged.
  if (!base.headers.has("x-middleware-next")) return base;
  const response = NextResponse.rewrite(new URL(path, request.url));
  for (const [name, value] of base.headers) {
    const lower = name.toLowerCase();
    if (lower === "x-middleware-next" || lower === "set-cookie") continue;
    response.headers.set(name, value);
  }
  for (const cookie of base.headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}

export const config = {
  matcher: [
    // Run on every page path, never on a file. A path with a dot anywhere
    // (/favicon.ico, /sw.js, /vendor/maplibre-gl/x/worker.mjs, a missing
    // /old.png) is a file, never a location slug, and must not run the
    // AuthKit refresh or write the lastLocation cookie. icons/ and vendor/
    // are listed too so a dot-less request under them can't become a slug.
    "/((?!_next/static|_next/image|icons/|vendor/|.*\\..*).*)",
  ],
};

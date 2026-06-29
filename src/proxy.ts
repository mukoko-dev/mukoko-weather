import { NextRequest } from "next/server";
import { authkit, handleAuthkitProxy } from "@workos-inc/authkit-nextjs";

/** Routes that are NOT location slugs — must match WeatherLoadingScene KNOWN_ROUTES */
const KNOWN_ROUTES = new Set([
  "explore", "shamwari", "history", "aviation", "about", "help",
  "privacy", "terms", "status", "embed", "offline", "api",
  // WorkOS AuthKit routes — never confuse with location slugs
  "auth", "callback",
]);

const SLUG_RE = /^[a-z0-9-]{1,80}$/;

/**
 * Edge middleware for instant location-aware routing + WorkOS AuthKit session.
 *
 * Three responsibilities, composed in order:
 * 1. Refresh the WorkOS session via `authkit(request)` — runs every request
 *    so `withAuth()` on the server side always sees a fresh session.
 * 2. Home page (GET /): returning users with a lastLocation cookie are
 *    redirected to their last location at the edge (still carrying AuthKit
 *    headers so the redirect doesn't drop the session).
 * 3. Location pages (GET /{slug}/*): set the lastLocation cookie on the
 *    response so the next home visit redirects them back without any geo
 *    lookup.
 */
export default async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always refresh the AuthKit session first so subsequent withAuth() reads
  // are fresh. The returned headers must be merged onto every outbound
  // response via handleAuthkitProxy.
  const { headers } = await authkit(request);

  // ── Home page: instant returning-user redirect ───────────────────────────
  if (pathname === "/") {
    const lastLocation = request.cookies.get("lastLocation")?.value;
    if (lastLocation && SLUG_RE.test(lastLocation)) {
      return handleAuthkitProxy(request, headers, {
        redirect: new URL(`/${lastLocation}`, request.url),
        redirectStatus: 307,
      });
    }
  }

  // ── Default response with AuthKit session cookies attached ───────────────
  const response = handleAuthkitProxy(request, headers);

  // ── Location pages: persist slug in cookie (30 days) ────────────────────
  // Only the first path segment — sub-routes like /harare/forecast set "harare"
  const slug = pathname.slice(1).split("/")[0];
  if (slug && SLUG_RE.test(slug) && !KNOWN_ROUTES.has(slug)) {
    response.cookies.set("lastLocation", slug, {
      maxAge: 2592000,
      path: "/",
      sameSite: "lax",
    });
  }

  return response;
}

export const config = {
  matcher: [
    // Run on every path except Next.js internals and static assets
    "/((?!_next/static|_next/image|favicon.ico|icons/|manifest.json|sw.js|apple-icon.png|icon.svg).*)",
  ],
};

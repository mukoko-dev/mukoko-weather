import { NextRequest, NextResponse } from "next/server";

/** Routes that are NOT location slugs — must match WeatherLoadingScene KNOWN_ROUTES */
const KNOWN_ROUTES = new Set([
  "explore", "shamwari", "history", "aviation", "about", "help",
  "privacy", "terms", "status", "embed", "offline", "api",
]);

const SLUG_RE = /^[a-z0-9-]{1,80}$/;

/**
 * Edge middleware for instant location-aware routing.
 *
 * Two responsibilities:
 * 1. Home page (GET /): returning users with a lastLocation cookie are
 *    redirected instantly at the edge — zero server computation, zero JS.
 * 2. Location pages (GET /{slug}/*): sets lastLocation cookie so the next
 *    home visit redirects them back without any geo lookup.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── Home page: instant returning-user redirect ───────────────────────────
  if (pathname === "/") {
    const lastLocation = request.cookies.get("lastLocation")?.value;
    if (lastLocation && SLUG_RE.test(lastLocation)) {
      return NextResponse.redirect(new URL(`/${lastLocation}`, request.url), {
        status: 307,
      });
    }
    return NextResponse.next();
  }

  // ── Location pages: persist slug in cookie (30 days) ────────────────────
  // Only the first path segment — sub-routes like /harare/forecast set "harare"
  const slug = pathname.slice(1).split("/")[0];
  if (slug && SLUG_RE.test(slug) && !KNOWN_ROUTES.has(slug)) {
    const response = NextResponse.next();
    response.cookies.set("lastLocation", slug, {
      maxAge: 2592000,
      path: "/",
      sameSite: "lax",
    });
    return response;
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Run on every path except Next.js internals and static assets
    "/((?!_next/static|_next/image|favicon.ico|icons/|manifest.json|sw.js|apple-icon.png|icon.svg).*)",
  ],
};

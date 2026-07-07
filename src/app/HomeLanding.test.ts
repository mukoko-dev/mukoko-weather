/**
 * Tests for HomeLanding — the home page city-chooser that replaced HomeRedirect.
 * Validates structure, accessibility, and both detected/fallback states.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "HomeLanding.tsx"), "utf-8");
const pageSource = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const middlewareSource = readFileSync(
  resolve(__dirname, "../proxy.ts"),
  "utf-8",
);

describe("HomeLanding — component structure", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("accepts detectedLocation prop", () => {
    expect(source).toContain("detectedLocation");
    expect(source).toContain("WeatherLocation");
  });

  it("uses router.replace for redirect (no history entry)", () => {
    expect(source).toContain("router.replace");
  });

  it("uses state to track cancellation", () => {
    // Previously a useRef — converted to useState so the render-time read
    // (Stage 1 short-circuit) is legal under react-hooks/refs.
    expect(source).toContain("cancelled");
    expect(source).toContain("useState(false)");
  });
});

describe("HomeLanding — detected city state", () => {
  it("shows the detected city name", () => {
    // Renders effectiveLocation (overridable by the silent travel recheck),
    // not the raw detectedLocation prop.
    expect(source).toContain("effectiveLocation.name");
  });

  it("shows countdown before redirecting", () => {
    expect(source).toContain("countdown");
    expect(source).toContain("setCountdown");
    expect(source).toContain("REDIRECT_DELAY_MS");
  });

  it("auto-redirects after delay", () => {
    expect(source).toContain("setTimeout");
    expect(source).toContain("router.replace");
  });

  it("cancels redirect when user chooses different city", () => {
    expect(source).toContain("handleCancel");
    expect(source).toContain("setCancelled(true)");
  });

  it("links to explore for choosing a different city", () => {
    expect(source).toContain('href="/explore"');
    expect(source).toContain("Choose a city");
  });

  it("cleans up timers on unmount", () => {
    expect(source).toContain("clearTimeout");
    expect(source).toContain("clearInterval");
  });
});

describe("HomeLanding — auto GPS on first visit", () => {
  it("auto-triggers GPS detection on mount for first-time visitors", () => {
    // GPS is the default — first visit auto-detects the user's precise location
    // instead of landing on the imprecise IP-guessed place.
    expect(source).toContain("autoDetecting");
    expect(source).toContain("detectUserLocation({ autoCreate: true })");
  });

  it("shows a 'Finding your location' state while auto-GPS runs", () => {
    expect(source).toContain("Finding your location");
    // Reuses the branded WeatherLoadingScene.
    expect(source).toContain("WeatherLoadingScene");
  });

  it("uses a one-time flag so returning users are not re-prompted", () => {
    expect(source).toContain("mukoko-gps-autoprompted");
    expect(source).toContain("localStorage");
  });

  it("respects returning users via store state", () => {
    // hasOnboarded / saved / selected location means the visitor is returning.
    expect(source).toContain("useAppStore");
    expect(source).toContain("hasOnboarded");
    expect(source).toContain("savedLocations");
  });

  it("also skips the auto-prompt for server-resolved returning visitors", () => {
    // isReturningUser (a resolved lastLocation cookie) is authoritative —
    // skip straight past the client-side heuristics when the server already
    // knows this is a returning visitor.
    expect(source).toContain("if (isReturningUser || isKnownReturningVisitor()) return;");
  });

  it("falls back to the IP-detected location on GPS failure", () => {
    // On denied/unavailable/error with an IP location present, re-enable the
    // countdown redirect instead of hanging.
    expect(source).toContain("setCancelled(false)");
    expect(source).toContain("detectedLocation");
  });

  it("defers the auto-GPS setState via requestAnimationFrame (lint-safe)", () => {
    expect(source).toContain("requestAnimationFrame");
    expect(source).toContain("cancelAnimationFrame");
  });
});

describe("HomeLanding — silent travel recheck for returning visitors", () => {
  it("accepts an isReturningUser prop", () => {
    expect(source).toContain("isReturningUser: boolean");
  });

  it("runs a silent, fast-timeout GPS recheck for returning visitors", () => {
    expect(source).toContain("SILENT_RECHECK_TIMEOUT_MS");
    expect(source).toContain("SILENT_RECHECK_MAX_AGE_MS");
    expect(source).toContain("timeoutMs: SILENT_RECHECK_TIMEOUT_MS");
    expect(source).toContain("maximumAgeMs: SILENT_RECHECK_MAX_AGE_MS");
  });

  it("swaps the redirect target when GPS resolves a different location", () => {
    expect(source).toContain("result.location.slug !== detectedLocation.slug");
    expect(source).toContain("setEffectiveLocation(result.location)");
  });

  it("gates the redirect on the recheck settling — current location takes precedence", () => {
    expect(source).toContain("recheckSettled");
    expect(source).toContain("!recheckSettled) return;");
    expect(source).toContain("RECHECK_SETTLE_CAP_MS");
    expect(source).toContain("setRecheckSettled(true)");
  });

  it("escalates to create-on-demand when the nearest known location is far", () => {
    expect(source).toContain("FAR_NEAREST_KM");
    expect(source).toContain("result.distanceKm != null && result.distanceKm > FAR_NEAREST_KM");
    expect(source).toContain("detectUserLocation({ autoCreate: true })");
  });

  it("failures leave the cached-location countdown untouched but still open the gate", () => {
    // GPS denial/failure/timeout must leave the cached-location countdown
    // target untouched — and the finally block must ALWAYS open the
    // redirect gate so the flow can never hang.
    expect(source).toContain("} finally {");
    expect(source).toContain("if (!disposed) setRecheckSettled(true);");
  });

  it("uses effectiveLocation (not the raw prop) as the redirect/render target", () => {
    // effectiveLocation starts equal to detectedLocation but can be
    // overridden by the silent recheck — the countdown effect and the
    // rendered "Taking you to X" text must read the overridable value.
    expect(source).toContain("useState(detectedLocation)");
    expect(source).toContain("router.replace(`/${effectiveLocation.slug}`)");
    expect(source).toContain("Taking you to ${effectiveLocation.name}");
  });
});

describe("HomeLanding — GPS button (stage 2)", () => {
  it("has a GPS button for explicit location detection", () => {
    expect(source).toContain("Use my current location");
    expect(source).toContain("handleGps");
    expect(source).toContain("detectUserLocation");
  });

  it("creates the location on demand from GPS (autoCreate)", () => {
    // "Use my current location" must create the location when none exists
    // nearby, not just find-nearest — otherwise sparse regions dead-end.
    expect(source).toContain("detectUserLocation({ autoCreate: true })");
    // handleGps treats a freshly-created location as a valid redirect target.
    expect(source).toContain('result.status === "created"');
  });

  it("shows detecting state while GPS is running", () => {
    expect(source).toContain("Detecting");
    expect(source).toContain("gpsState");
  });

  it("shows error message when GPS is denied (via shared i18n copy)", () => {
    expect(source).toContain("denied");
    // Copy is single-sourced in i18n's geo.denied / geo.error keys — the
    // literal string must NOT be hand-rolled here anymore.
    expect(source).toContain('t("geo.denied")');
    expect(source).toContain('t("geo.error")');
    expect(source).not.toContain("Location access denied —");
  });
});

describe("HomeLanding — no detection state", () => {
  it("shows a heading when no location detected", () => {
    expect(source).toContain("Find your weather");
  });

  it("links to explore from the fallback state", () => {
    expect(source).toContain("Browse all locations");
  });

  it("shows GPS button as primary action in fallback state", () => {
    expect(source).toContain("NavigationIcon");
  });
});

describe("HomeLanding — accessibility", () => {
  it("has a main landmark with id for skip-to-content", () => {
    expect(source).toContain('id="main-content"');
  });

  it("has aria-label on the main element", () => {
    expect(source).toContain("aria-label");
  });

  it("has progressbar role for countdown", () => {
    expect(source).toContain('role="progressbar"');
  });

  it("has minimum touch targets on interactive elements", () => {
    expect(source).toContain("min-h-[var(--touch-target-min)]");
  });
});

describe("page.tsx — server component", () => {
  it("is NOT a client component", () => {
    expect(pageSource).not.toContain('"use client"');
  });

  it("reads Vercel IP geolocation headers", () => {
    expect(pageSource).toContain("x-vercel-ip-latitude");
    expect(pageSource).toContain("x-vercel-ip-longitude");
  });

  it("reads the lastLocation cookie to resolve a returning visitor's cached location", () => {
    expect(pageSource).toContain("lastLocation");
    expect(pageSource).toContain("cookies()");
  });

  it("fetches /api/py/geo with lat/lon from headers", () => {
    expect(pageSource).toContain("/api/py/geo");
    expect(pageSource).toContain("lat=");
    expect(pageSource).toContain("lon=");
  });

  it("renders HomeLanding with detectedLocation and isReturningUser props", () => {
    expect(pageSource).toContain("HomeLanding");
    expect(pageSource).toContain("detectedLocation");
    expect(pageSource).toContain("isReturningUser");
  });

  it("keeps canonical URL pointing to /harare for SEO", () => {
    expect(pageSource).toContain("/harare");
    expect(pageSource).toContain("canonical");
  });

  it("uses autoCreate=false on the server IP-geo path (find-only, no junk locations)", () => {
    expect(pageSource).toContain("autoCreate=false");
    expect(pageSource).not.toContain("autoCreate=true");
  });

  it("bounds the self-fetch with an AbortController timeout", () => {
    expect(pageSource).toContain("AbortController");
    expect(pageSource).toContain("controller.abort()");
    expect(pageSource).toContain("signal: controller.signal");
    expect(pageSource).toContain("GEO_FETCH_TIMEOUT_MS");
  });

  it("uses a stable base URL for the self-fetch (not VERCEL_URL)", () => {
    expect(pageSource).not.toContain("VERCEL_URL");
    expect(pageSource).toContain('process.env.NODE_ENV === "production"');
  });

  it("only trusts a lastLocation cookie that actually resolves", () => {
    expect(pageSource).toContain("getLocationFromDb(lastLocation)");
    // The resolution check gates isReturningUser, breaking the stale-cookie loop
    // (an unresolvable slug falls through to fresh IP-geo detection instead).
    expect(pageSource).toContain("if (resolved)");
  });

  it("does not redirect the cookie-resolved case — GPS recheck happens client-side", () => {
    // Device GPS only exists in the browser. Server-side redirecting straight
    // to the cached location (as before) would skip HomeLanding's silent
    // travel recheck entirely and strand travelers on their old city.
    expect(pageSource).not.toContain("redirect(");
    expect(pageSource).not.toContain('from "next/navigation"');
  });

  it("skips the IP-geo lookup entirely when a cached location was already resolved", () => {
    expect(pageSource).toContain("if (!detectedLocation) {");
  });
});

describe("middleware — edge routing", () => {
  it("does NOT redirect the home page at the edge", () => {
    // Device GPS only exists in the browser — the edge middleware has no way
    // to check whether a returning visitor has travelled since their last
    // visit. An instant edge redirect straight to the cached lastLocation
    // would skip that check entirely and strand travelers on their old city
    // every time they open the app. The redirect decision (and the silent
    // GPS recheck that can override it) now lives entirely in HomeLanding.
    expect(middlewareSource).not.toContain('pathname === "/"');
    expect(middlewareSource).not.toContain("redirect:");
    expect(middlewareSource).toContain("HomeLanding");
  });

  it("still composes AuthKit session headers onto every response", () => {
    expect(middlewareSource).toMatch(/handleAuthkitProxy/);
  });

  it("sets lastLocation cookie on location page visits", () => {
    expect(middlewareSource).toContain("cookies.set");
    expect(middlewareSource).toContain('"lastLocation"');
    expect(middlewareSource).toContain("maxAge: 2592000");
  });

  it("validates slug before setting cookie (no injection)", () => {
    expect(middlewareSource).toContain("SLUG_RE.test");
  });

  it("excludes known app routes from cookie setting", () => {
    expect(middlewareSource).toContain("KNOWN_ROUTES");
    expect(middlewareSource).toContain('"explore"');
    expect(middlewareSource).toContain('"shamwari"');
  });

  it("composes WorkOS AuthKit session refresh into the middleware chain", () => {
    // Phase 1a: every request must run authkit() so withAuth() sees a fresh
    // session, and "auth" / "callback" must be in KNOWN_ROUTES so they
    // aren't mistaken for location slugs.
    expect(middlewareSource).toContain("@workos-inc/authkit-nextjs");
    expect(middlewareSource).toMatch(/authkit\s*\(/);
    expect(middlewareSource).toContain('"auth"');
    expect(middlewareSource).toContain('"callback"');
  });
});

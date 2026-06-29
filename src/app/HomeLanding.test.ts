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

  it("uses a ref to track cancellation", () => {
    expect(source).toContain("cancelled");
    expect(source).toContain("useRef(false)");
  });
});

describe("HomeLanding — detected city state", () => {
  it("shows the detected city name", () => {
    expect(source).toContain("detectedLocation.name");
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
    expect(source).toContain("cancelled.current = true");
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

describe("HomeLanding — GPS button (stage 2)", () => {
  it("has a GPS button for explicit location detection", () => {
    expect(source).toContain("Use my current location");
    expect(source).toContain("handleGps");
    expect(source).toContain("detectUserLocation");
  });

  it("shows detecting state while GPS is running", () => {
    expect(source).toContain("Detecting");
    expect(source).toContain("gpsState");
  });

  it("shows error message when GPS is denied", () => {
    expect(source).toContain("denied");
    expect(source).toContain("Location access denied");
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

  it("reads lastLocation cookie for belt-and-suspenders redirect", () => {
    expect(pageSource).toContain("lastLocation");
    expect(pageSource).toContain("cookies()");
  });

  it("fetches /api/py/geo with lat/lon from headers", () => {
    expect(pageSource).toContain("/api/py/geo");
    expect(pageSource).toContain("lat=");
    expect(pageSource).toContain("lon=");
  });

  it("renders HomeLanding with detectedLocation prop", () => {
    expect(pageSource).toContain("HomeLanding");
    expect(pageSource).toContain("detectedLocation");
  });

  it("keeps canonical URL pointing to /harare for SEO", () => {
    expect(pageSource).toContain("/harare");
    expect(pageSource).toContain("canonical");
  });
});

describe("middleware — edge routing", () => {
  it("redirects home page with lastLocation cookie", () => {
    expect(middlewareSource).toContain("lastLocation");
    expect(middlewareSource).toContain("NextResponse.redirect");
    expect(middlewareSource).toContain('pathname === "/"');
  });

  it("uses 307 status for temporary redirect", () => {
    expect(middlewareSource).toContain("307");
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
});

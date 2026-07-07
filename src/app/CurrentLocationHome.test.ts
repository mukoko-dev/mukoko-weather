/**
 * Tests for CurrentLocationHome — the silent-URL home: `/` renders the
 * current-location weather INLINE (Apple Weather's MY LOCATION model). No
 * redirect, no countdown — the server seeds the dashboard with the best
 * known location, and client GPS swaps the content in place.
 * Also covers page.tsx (server seeding) and proxy.ts (edge routing).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "CurrentLocationHome.tsx"), "utf-8");
const pageSource = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const middlewareSource = readFileSync(resolve(__dirname, "../proxy.ts"), "utf-8");

describe("CurrentLocationHome — silent-URL model", () => {
  it("is a client component that renders the dashboard inline", () => {
    expect(source).toContain('"use client"');
    expect(source).toContain("<WeatherDashboard");
  });

  it("NEVER redirects — no router navigation exists in the flow", () => {
    // The whole point: home IS the destination. There is no redirect for a
    // saved location to win, so current location precedes saved by
    // construction.
    expect(source).not.toContain("router.replace");
    expect(source).not.toContain("router.push");
    expect(source).not.toContain("useRouter");
  });

  it("swaps the dashboard in place when GPS resolves a different slug", () => {
    expect(source).toContain("resolved.slug !== initial?.location.slug");
    expect(source).toContain("await swapTo(resolved");
    expect(source).toContain("fetchWeather(location.lat, location.lon)");
  });

  it("remounts the dashboard per location via key", () => {
    expect(source).toContain("key={view.location.slug}");
  });

  it("escalates to create-on-demand when the nearest known location is far", () => {
    expect(source).toContain("FAR_NEAREST_KM");
    expect(source).toContain("result.distanceKm != null && result.distanceKm > FAR_NEAREST_KM");
    expect(source).toContain("detectUserLocation({ autoCreate: true })");
  });

  it("refreshes the lastLocation cookie so the next server render seeds the new spot", () => {
    expect(source).toContain("document.cookie = `lastLocation=${location.slug}");
    expect(source).toContain("max-age=2592000");
  });

  it("silently refreshes when permission is already granted; auto-prompts only once", () => {
    expect(source).toContain('navigator.permissions?.query({ name: "geolocation" })');
    expect(source).toContain("GPS_AUTOPROMPT_KEY");
    expect(source).toContain("if (!granted && promptedBefore) return;");
  });

  it("skips GPS outright when permission is denied", () => {
    expect(source).toContain('status?.state === "denied"');
  });

  it("marks the dashboard as current-location only after GPS confirms", () => {
    expect(source).toContain("gpsConfirmed");
    expect(source).toContain("isCurrentLocation={gpsConfirmed}");
  });

  it("syncs the store and tracks analytics on a swap", () => {
    expect(source).toContain("setSelectedLocation(location.slug)");
    expect(source).toContain('trackEvent("location_changed"');
    expect(source).toContain('method: "geolocation"');
  });
});

describe("CurrentLocationHome — GPS chooser fallback", () => {
  it("keeps the manual GPS + browse fallback for visitors with nothing seeded", () => {
    expect(source).toContain("Use my current location");
    expect(source).toContain("Browse all locations");
    expect(source).toContain("Find your weather");
  });

  it("manual GPS creates the location on demand (autoCreate)", () => {
    expect(source).toContain("detectUserLocation({ autoCreate: true })");
    expect(source).toContain('result.status === "created"');
  });

  it("shows the loading scene while GPS runs with nothing seeded", () => {
    expect(source).toContain("WeatherLoadingScene");
    expect(source).toContain("Finding your location…");
  });

  it("shows error copy from shared i18n keys", () => {
    expect(source).toContain('t("geo.denied")');
    expect(source).toContain('t("geo.error")');
  });

  it("keeps the accessible main landmark in the chooser state", () => {
    expect(source).toContain('id="main-content"');
    expect(source).toContain("aria-label");
  });
});

describe("page.tsx — server seeding", () => {
  it("is NOT a client component", () => {
    expect(pageSource).not.toContain('"use client"');
  });

  it("renders the dashboard payload for the cookie-resolved location", () => {
    expect(pageSource).toContain("getWeatherForLocation");
    expect(pageSource).toContain("HomeWeatherPayload");
    expect(pageSource).toContain("<CurrentLocationHome initial={initial}");
  });

  it("reads Vercel IP geolocation headers as the no-cookie fallback", () => {
    expect(pageSource).toContain("x-vercel-ip-latitude");
    expect(pageSource).toContain("x-vercel-ip-longitude");
  });

  it("reads the lastLocation cookie to seed a returning visitor", () => {
    expect(pageSource).toContain("lastLocation");
    expect(pageSource).toContain("cookies()");
  });

  it("only trusts a lastLocation cookie that actually resolves", () => {
    expect(pageSource).toContain("getLocationFromDb(lastLocation)");
    expect(pageSource).toContain("if (resolved)");
  });

  it("uses autoCreate=false on the server IP-geo path (find-only, no junk locations)", () => {
    expect(pageSource).toContain("autoCreate=false");
    expect(pageSource).not.toContain("autoCreate=true");
  });

  it("bounds the self-fetch with an AbortController timeout", () => {
    expect(pageSource).toContain("AbortController");
    expect(pageSource).toContain("controller.abort()");
    expect(pageSource).toContain("GEO_FETCH_TIMEOUT_MS");
  });

  it("uses a stable base URL for the self-fetch (not VERCEL_URL)", () => {
    expect(pageSource).not.toContain("VERCEL_URL");
    expect(pageSource).toContain('process.env.NODE_ENV === "production"');
  });

  it("NEVER redirects — home is real content now", () => {
    expect(pageSource).not.toContain("redirect(");
  });

  it("canonical is the home page itself (it is real content, not a chooser)", () => {
    expect(pageSource).toContain("canonical: `${BASE_URL}/`");
    expect(pageSource).not.toContain("canonical: `${BASE_URL}/harare`");
  });

  it("double-catches the weather fetch so the shell always renders", () => {
    expect(pageSource).toContain("createFallbackWeather");
  });

  it("skips the IP-geo lookup entirely when a cached location was already resolved", () => {
    expect(pageSource).toContain("if (!detectedLocation) {");
  });
});

describe("middleware — edge routing", () => {
  it("does NOT redirect the home page at the edge", () => {
    // Device GPS only exists in the browser — the edge can never know the
    // visitor's current location, so it must not route home traffic.
    expect(middlewareSource).not.toContain("NextResponse.redirect");
  });

  it("persists the lastLocation cookie on /{slug} pages (30 days)", () => {
    expect(middlewareSource).toContain('"lastLocation"');
    expect(middlewareSource).toContain("2592000");
  });
});

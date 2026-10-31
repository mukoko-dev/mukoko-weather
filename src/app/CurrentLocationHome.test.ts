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

const source = readFileSync(
  resolve(__dirname, "CurrentLocationHome.tsx"),
  "utf-8",
);
const pageSource = readFileSync(resolve(__dirname, "page.tsx"), "utf-8");
const middlewareSource = readFileSync(
  resolve(__dirname, "../proxy.ts"),
  "utf-8",
);

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
    expect(source).toContain("resolved.slug === view?.location.slug");
    expect(source).toContain("await swapTo(resolved");
  });

  it("loads swapped weather through our own API, not the browser's Open-Meteo quota", () => {
    // A browser-side Open-Meteo 429 used to surface as "Could not detect
    // location" even though GPS had worked.
    expect(source).toContain("fetchHomeWeather(");
    expect(source).not.toMatch(/\bfetchWeather\(/);
  });

  it("remounts the dashboard per location via key", () => {
    expect(source).toContain("key={view.location.slug}");
  });

  it("escalates to create-on-demand when the nearest known location is far", () => {
    // The far-match rule itself is behaviour-tested in location-choice.test.ts.
    expect(source).toContain("FAR_NEAREST_KM");
    expect(source).toMatch(/detectUserLocation\(\{\s*autoCreate: true/);
  });

  it("decides create-on-demand and the final place through src/lib/location-choice.ts", () => {
    // The decisions are pure and covered by behaviour tests in
    // location-choice.test.ts (a spot named on demand escalates; a placeholder
    // spot never does; a placeholder never replaces a real nearby place).
    expect(source).toContain("shouldCreate(result, FAR_NEAREST_KM)");
    expect(source).toContain("chooseResolved(result, precise)");
  });

  it("keeps the seeded place rather than relabelling a far one as MY LOCATION", () => {
    // Singapore audit: a POI ~9 km away was shown as MY LOCATION.
    expect(source).toMatch(/const FAR_NEAREST_KM = [1-5];/);
    // Behaviour of the choice: location-choice.test.ts (chooseResolved).
    expect(source).toContain("!usable && view");
  });

  it("refreshes the lastLocation cookie so the next server render seeds the new spot", () => {
    expect(source).toContain("writeLastLocationCookie(location.slug)");
    const helper = readFileSync(
      resolve(__dirname, "../lib/current-slug.ts"),
      "utf-8",
    );
    expect(helper).toContain(
      "document.cookie = `${LAST_LOCATION_COOKIE}=${slug}",
    );
    expect(helper).toContain("max-age=${LAST_LOCATION_MAX_AGE_S}");
    const lastLocation = readFileSync(
      resolve(__dirname, "../lib/last-location.ts"),
      "utf-8",
    );
    expect(lastLocation).toContain("LAST_LOCATION_MAX_AGE_S = 2592000");
  });

  it("picks up a place found by the header's My Location button while on /", () => {
    expect(source).toContain(
      "window.addEventListener(CURRENT_LOCATION_EVENT, onLocated)",
    );
  });

  it("refreshes silently only when permission is already granted — never prompts on load", () => {
    expect(source).toContain('readBrowserPermission("geolocation")');
    expect(source).toContain("decideLocationAsk(");
    expect(source).toContain('if (ask !== "refresh-silently") {');
    // The old once-ever auto-prompt is gone: the prompt only follows a tap.
    expect(source).not.toContain("GPS_AUTOPROMPT_KEY");
  });

  it("remembers the outcome per device and never re-asks after a block", () => {
    expect(source).toContain('recordPermission("geolocation", "denied")');
    expect(source).toContain('recordPermission("geolocation", "granted")');
    // "Not now" is not a block; it is its own state with a retry window.
    expect(source).toContain('recordPermission("geolocation", "dismissed")');
    expect(source).toContain('if (ask !== "show-prompt") setDismissed(true);');
    expect(source).toContain("LEGACY_LOCATION_CARD_DISMISSED_KEY");
  });

  it("reports a signed-in device to the account without blocking", () => {
    expect(source).toContain("useDeviceHeartbeat(Boolean(user))");
  });

  it("explains a blocked permission instead of failing silently", () => {
    expect(source).toContain("Location is blocked in your browser settings.");
  });

  it("offers location through one dismissible card over the seeded weather", () => {
    expect(source).toContain("<LocationPromptCard");
    expect(source).toContain(
      "const showCard = promptReady && !gpsConfirmed && !dismissed;",
    );
  });

  it("tells a weather failure apart from a location failure", () => {
    expect(source).toContain('return "no-weather";');
    expect(source).toContain('"no-location"');
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

  it("accepts a created location from the lookup", () => {
    expect(source).toContain('result.status !== "created"');
  });

  it("never blocks the screen while GPS runs — the button shows progress", () => {
    // The old full-screen "Finding your location…" scene had no way out.
    expect(source).not.toContain("LocationSkeleton");
    expect(source).toContain('aria-busy={gpsState === "detecting"}');
    expect(source).toContain("Finding your location…");
  });

  it("always offers search as a way forward", () => {
    expect(source).toContain("Search for a city");
    expect(source).toContain("onSearch={() => openMyWeather()}");
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
    expect(pageSource).toContain("loadLocationWeather");
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

  it("asks the geo endpoint without spending a lookup and keeps only usable answers", () => {
    // Behaviour of the filter: location-choice.test.ts (usableIpGeo).
    expect(pageSource).toContain("noName=1");
    expect(pageSource).toContain("usableIpGeo(");
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

  it("asks the Rust Worker, never a self-fetch (no VERCEL_URL, no /api/py)", () => {
    expect(pageSource).not.toContain("VERCEL_URL");
    expect(pageSource).not.toContain("/api/py");
    expect(pageSource).toContain("fetchPlaces(");
  });

  it("never holds the first paint past a deadline: it streams the client chooser instead", () => {
    expect(pageSource).toContain("HOME_SEED_DEADLINE_MS");
    expect(pageSource).toContain(
      "withinDeadline(buildHome(), HOME_SEED_DEADLINE_MS)",
    );
  });

  it("NEVER redirects — home is real content now", () => {
    expect(pageSource).not.toContain("redirect(");
  });

  it("canonical is the home page itself (it is real content, not a chooser)", () => {
    expect(pageSource).toContain("canonical: `${SITE_URL}/`");
    expect(pageSource).not.toContain("canonical: `${BASE_URL}/harare`");
  });

  it("double-catches the weather fetch so the shell always renders", () => {
    // The fallback lives in the shared payload helper (src/lib/location-payload.ts).
    expect(pageSource).toContain("loadLocationWeather(");
    const payload = readFileSync(
      resolve(__dirname, "../lib/location-payload.ts"),
      "utf-8",
    );
    expect(payload).toContain("createFallbackWeather(");
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
    // The name and lifetime are constants in src/lib/last-location.ts.
    expect(middlewareSource).toContain("LAST_LOCATION_COOKIE");
    expect(middlewareSource).toContain("LAST_LOCATION_MAX_AGE_S");
    expect(middlewareSource).toContain('from "@/lib/last-location"');
  });
});

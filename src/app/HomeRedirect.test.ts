/**
 * Tests for HomeRedirect — validates the smart home page redirect logic
 * that routes returning users to their saved location and new users
 * through geolocation detection.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "HomeRedirect.tsx"),
  "utf-8",
);

describe("HomeRedirect — component structure", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("uses router.replace to avoid history entries", () => {
    expect(source).toContain("router.replace");
  });

  it("uses a ref to prevent duplicate redirects", () => {
    expect(source).toContain("hasRedirected");
    expect(source).toContain("useRef(false)");
  });

  it("renders WeatherLoadingScene while waiting", () => {
    expect(source).toContain("WeatherLoadingScene");
    expect(source).toContain("Finding your location");
  });
});

describe("HomeRedirect — Zustand rehydration guard", () => {
  it("imports hasStoreHydrated from store", () => {
    expect(source).toContain("hasStoreHydrated");
    expect(source).toMatch(/import.*hasStoreHydrated.*from/);
  });

  it("tracks hydration state before acting", () => {
    // Should not act on default Zustand values before localStorage loads
    expect(source).toContain("hydrated");
    expect(source).toContain("setHydrated");
  });

  it("waits for hydration before checking persisted state", () => {
    // The redirect effect should check hydration
    expect(source).toContain("!hydrated");
  });

  it("retries rAF polling until hydration completes", () => {
    // Should retry via recursive rAF, not a single poll
    expect(source).toContain("requestAnimationFrame(check)");
  });

  it("has a max-wait timeout for hydration polling", () => {
    // Prevents infinite polling if Zustand persist never fires
    expect(source).toContain("HYDRATION_TIMEOUT_MS");
    expect(source).toContain("4000");
    expect(source).toContain("clearTimeout");
  });
});

describe("HomeRedirect — redirect logic", () => {
  it("always attempts geolocation first (current location default)", () => {
    expect(source).toContain("detectUserLocation");
    expect(source).toContain("selectedLocation");
  });

  it("reads fallback from store at decision time (not stale closure)", () => {
    // Fallback should be read inside .then()/.catch() callbacks via
    // useAppStore.getState() so device sync changes are reflected
    expect(source).toContain("useAppStore.getState()");
    expect(source).toContain("savedLocations[0] || selectedLocation || FALLBACK_LOCATION");
  });

  it("uses savedLocations as fallback chain", () => {
    expect(source).toContain("savedLocations");
  });

  it("waits for geolocation to resolve naturally (no aggressive timeout race)", () => {
    // Should NOT have a short GEO_TIMEOUT_MS that races against the browser
    // permission prompt — the old 3s timeout caused premature Harare redirects
    expect(source).not.toContain("GEO_TIMEOUT_MS");
    expect(source).not.toContain("Promise.race");
  });

  it("has a 15-second safety timeout as last resort", () => {
    expect(source).toContain("SAFETY_TIMEOUT_MS");
    expect(source).toContain("15000");
  });

  it("falls back to harare when geolocation fails", () => {
    expect(source).toContain("FALLBACK_LOCATION");
    expect(source).toContain('"harare"');
  });

  it("uses detectUserLocation for geolocation", () => {
    expect(source).toContain("detectUserLocation");
  });

  it("handles both success and created geolocation statuses", () => {
    expect(source).toContain('"success"');
    expect(source).toContain('"created"');
  });

  it("cancels geolocation on unmount", () => {
    expect(source).toContain("cancelled = true");
  });

  it("clears safety timer on unmount", () => {
    expect(source).toContain("clearTimeout(safetyTimer)");
  });

  it("handles geolocation promise rejection", () => {
    // .catch() prevents unhandled promise rejections
    expect(source).toContain(".catch(");
  });
});

describe("HomeRedirect — location fallback link", () => {
  it("shows a fallback city link after a short delay", () => {
    expect(source).toContain("showSkip");
    expect(source).toContain("setShowSkip");
    expect(source).toContain("SKIP_DELAY_MS");
  });

  it("delays fallback link appearance with setTimeout", () => {
    // The skip link should appear after a timeout, not immediately
    expect(source).toContain("setTimeout(() => setShowSkip(true)");
  });

  it("links to /explore as the fallback destination", () => {
    expect(source).toContain('href="/explore"');
  });

  it("renders the fallback as an action prop in WeatherLoadingScene", () => {
    expect(source).toContain("action=");
    expect(source).toContain("Choose a city instead");
  });

  it("uses animate-fade-in-up for smooth appearance", () => {
    expect(source).toContain("animate-fade-in-up");
  });

  it("has proper min touch target on the fallback link", () => {
    expect(source).toContain("min-h-[44px]");
  });
});

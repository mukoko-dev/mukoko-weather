import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "ExploreSearch.tsx"), "utf-8");

/**
 * ExploreSearch component tests.
 *
 * Tests focus on component contract, AI search integration,
 * and architecture compliance.
 */

describe("ExploreSearch — instant quick matches", () => {
  it("uses the shared quick-location-search hook — same one MyWeatherModal uses", () => {
    // Single shared implementation (debounce, cancellation, result shape)
    // instead of a hand-rolled copy, so typing a city name here behaves the
    // same way it does everywhere else in the app — the AI search below is
    // a separate, deliberate step.
    expect(source).toContain('from "@/lib/use-location-quick-search"');
    expect(source).toContain("useLocationQuickSearch({ limit: 6 })");
  });

  it("shows quick results as plain location links, independent of the AI search results", () => {
    expect(source).toContain("quickResults");
    expect(source).toContain('aria-label="Quick location matches"');
  });

  it("shows a no-results message instead of nothing when a query returns no matches", () => {
    expect(source).toContain("No results for");
  });
});

describe("ExploreSearch component structure", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("exports ExploreSearch as a named export", () => {
    expect(source).toContain("export function ExploreSearch");
  });

  it("has aria-labelledby for accessibility", () => {
    expect(source).toContain('aria-labelledby="explore-search-heading"');
    expect(source).toContain('id="explore-search-heading"');
  });

  it("has 56px minimum touch targets", () => {
    expect(source).toContain("min-h-[var(--touch-target-min)]");
  });
});

describe("search flow", () => {
  it("uses form submission pattern", () => {
    expect(source).toContain("onSubmit={handleSubmit}");
    expect(source).toContain("e.preventDefault()");
  });

  it("sends POST to /api/py/explore/search", () => {
    expect(source).toContain('fetch("/api/py/explore/search"');
  });

  it("sends query in request body", () => {
    expect(source).toContain("query: trimmed");
  });

  it("trims whitespace before searching", () => {
    expect(source).toContain("searchQuery.trim()");
  });

  it("prevents search when loading or empty", () => {
    expect(source).toContain("!trimmed || loading");
  });

  it("input has aria-label", () => {
    expect(source).toContain('aria-label="Search locations"');
  });

  it("disables input while loading", () => {
    expect(source).toContain("disabled={loading}");
  });
});

describe("results rendering", () => {
  it("renders location cards as links", () => {
    expect(source).toContain("href={`/${loc.slug}`}");
  });

  it("shows temperature when available", () => {
    expect(source).toContain("loc.temperature != null");
    expect(source).toContain("Math.round(loc.temperature)");
  });

  it("shows weather code label", () => {
    expect(source).toContain("weatherCodeToInfo");
  });

  it("shows location tags", () => {
    expect(source).toContain("loc.tags");
    expect(source).toContain(".slice(0, 3)");
  });

  it("shows AI summary", () => {
    expect(source).toContain("{summary}");
  });

  it("uses MapPinIcon for location cards", () => {
    expect(source).toContain("<MapPinIcon");
  });
});

describe("Shamwari context integration", () => {
  // The feature-flag gate + setShamwariContext handoff + link rendering now
  // live in the shared <ShamwariCTA> component (@/components/weather/ShamwariCTA)
  // instead of being hand-rolled here — see ShamwariCTA's own tests for that
  // behavior. This file only asserts ExploreSearch builds the right context.
  it("imports ShamwariCTA", () => {
    expect(source).toContain("ShamwariCTA");
    expect(source).toContain("@/components/weather/ShamwariCTA");
  });

  it("sets explore context when navigating to Shamwari", () => {
    expect(source).toContain('source: "explore"');
    expect(source).toContain("exploreQuery: query");
  });

  it("has an 'Ask Shamwari for more' CTA", () => {
    expect(source).toContain("Ask Shamwari for more");
  });
});

describe("UI patterns", () => {
  it("uses global styles only — no hardcoded colors", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}[^)]/);
    expect(source).not.toContain("style={{");
  });

  it("shows loading spinner in button", () => {
    // Spinner is the shared primitive (src/components/ui/spinner.tsx)
    expect(source).toContain("<Spinner");
  });

  it("shows empty state when no results", () => {
    expect(source).toContain("No locations found");
  });
});

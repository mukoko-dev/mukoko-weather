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

  it("has 44px minimum touch targets", () => {
    expect(source).toContain("min-h-[44px]");
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
  it("imports useAppStore for context setting", () => {
    expect(source).toContain("useAppStore");
    expect(source).toContain("setShamwariContext");
  });

  it("sets explore context when navigating to Shamwari", () => {
    expect(source).toContain('source: "explore"');
    expect(source).toContain("exploreQuery: query");
  });

  it("has an 'Ask Shamwari for more' link", () => {
    expect(source).toContain("Ask Shamwari for more");
    expect(source).toContain('href="/shamwari"');
  });
});

describe("UI patterns", () => {
  it("uses global styles only — no hardcoded colors", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}[^)]/);
    expect(source).not.toContain("style={{");
  });

  it("shows loading spinner in button", () => {
    expect(source).toContain("animate-spin");
  });

  it("shows empty state when no results", () => {
    expect(source).toContain("No locations found");
  });
});

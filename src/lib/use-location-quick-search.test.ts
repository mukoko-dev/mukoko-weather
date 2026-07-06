/**
 * Tests for useLocationQuickSearch — the shared debounced quick-match
 * location search extracted from MyWeatherModal and ExploreSearch so both
 * consumers can't silently drift from each other again.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "use-location-quick-search.ts"),
  "utf-8",
);

describe("useLocationQuickSearch — module structure", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("exports useLocationQuickSearch as a named export", () => {
    expect(source).toContain("export function useLocationQuickSearch");
  });

  it("builds on the shared useDebounce hook", () => {
    expect(source).toContain('from "./use-debounce"');
    expect(source).toContain("useDebounce(query, debounceMs)");
  });

  it("defaults to a 300ms debounce and a 10-result limit", () => {
    expect(source).toContain("debounceMs = 300");
    expect(source).toContain("limit = 10");
  });

  it("calls the shared /api/py/search endpoint", () => {
    expect(source).toContain("/api/py/search?q=");
  });

  it("cancels in-flight requests on rapid typing", () => {
    expect(source).toContain("AbortController");
    expect(source).toContain("controller.signal");
    expect(source).toContain("controller.abort()");
  });

  it("returns query, setQuery, results, loading, and reset", () => {
    expect(source).toContain("query,");
    expect(source).toContain("setQuery,");
    expect(source).toContain("results,");
    expect(source).toContain("loading,");
    expect(source).toContain("reset };");
  });

  it("reset synchronously clears both query and results (avoids a stale-results flash)", () => {
    expect(source).toContain("const reset = useCallback(() => {");
    expect(source).toContain('setQuery("");\n    setResults([]);');
  });

  it("clears results for an empty query without a network request", () => {
    expect(source).toContain("if (!q || q.length < minLength) {");
    expect(source).toContain("setResults([])");
  });

  it("defers the empty-query clear via requestAnimationFrame (avoids sync setState in effect)", () => {
    expect(source).toContain("const raf = requestAnimationFrame(() => {");
    expect(source).toContain("setResults([]);");
    expect(source).toContain("cancelAnimationFrame(raf)");
  });

  it("defers the fetch kickoff (and its setLoading(true)) via requestAnimationFrame too", () => {
    // setLoading(true) called synchronously in the effect body — even
    // guarding a fetch — trips the same lint rule as the empty-query case.
    expect(source).toContain("const raf = requestAnimationFrame(() => {");
    expect(source).toContain("setLoading(true);");
  });
});

describe("useLocationQuickSearch — minLength + error surfacing (issue #103)", () => {
  it("supports a minLength option so short queries never fire a request", () => {
    expect(source).toContain("minLength = 1");
    expect(source).toContain("q.length < minLength");
  });

  it("exposes an error flag: set on failure, cleared on success/empty/reset", () => {
    expect(source).toContain("error: boolean");
    expect(source).toContain("setError(true)");
    // Cleared in the empty-query branch, on success, and in reset().
    expect(source.split("setError(false)").length - 1).toBeGreaterThanOrEqual(3);
  });

  it("backs HistoryDashboard and AviationPlanner (no hand-rolled search remains)", () => {
    const history = readFileSync(resolve(__dirname, "../app/history/HistoryDashboard.tsx"), "utf-8");
    const aviation = readFileSync(resolve(__dirname, "../app/aviation/AviationPlanner.tsx"), "utf-8");
    for (const src of [history, aviation]) {
      expect(src).toContain("useLocationQuickSearch");
      expect(src).not.toContain("/api/py/search?q=");
    }
    // The old HistoryDashboard debounce had no AbortController — a stale slow
    // response could overwrite newer results. The hook owns cancellation now.
    expect(history).not.toContain("searchTimer");
  });
});

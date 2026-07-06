/**
 * Tests for RouteErrorBoundary — the single shared body behind every
 * route-level error.tsx (issue #102). Structural checks: the boundary logic
 * (retry tracking, analytics, issue reporting) exists exactly once here, and
 * all 8 route error files are thin wrappers around it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "RouteErrorBoundary.tsx"), "utf-8");

const ERROR_FILES: Record<string, { source: string; retryTracked: boolean }> = {
  "../../app/error.tsx": { source: "global", retryTracked: true },
  "../../app/shamwari/error.tsx": { source: "shamwari", retryTracked: true },
  "../../app/history/error.tsx": { source: "history", retryTracked: true },
  "../../app/[location]/error.tsx": { source: "location", retryTracked: true },
  "../../app/aviation/error.tsx": { source: "aviation", retryTracked: true },
  "../../app/explore/country/error.tsx": { source: "explore-country", retryTracked: false },
  "../../app/explore/country/[code]/error.tsx": { source: "explore-country-detail", retryTracked: false },
  "../../app/explore/country/[code]/[province]/error.tsx": { source: "explore-province-detail", retryTracked: false },
};

describe("RouteErrorBoundary — shared boundary body", () => {
  it("owns the retry-tracking logic (sessionStorage cap via error-retry)", () => {
    expect(source).toContain("getRetryCount");
    expect(source).toContain("setRetryCount");
    expect(source).toContain("clearRetryCount");
    expect(source).toContain("MAX_RETRIES");
  });

  it("reports to analytics with the caller's source prefix, fatal only when retry-tracked", () => {
    expect(source).toContain("reportErrorToAnalytics(`${source}:${error.message}`, retryTracking)");
  });

  it("renders the issue-report link only for retry-tracked boundaries", () => {
    expect(source).toContain("buildIssueUrl");
    expect(source).toContain("{retryTracking && (");
  });

  it("lightweight mode retries directly without touching the retry counter", () => {
    expect(source).toMatch(/if \(!retryTracking\) \{\s*reset\(\);/);
  });
});

describe("route error.tsx files — thin wrappers (issue #102)", () => {
  for (const [file, meta] of Object.entries(ERROR_FILES)) {
    it(`${file} wraps RouteErrorBoundary with source="${meta.source}"`, () => {
      const src = readFileSync(resolve(__dirname, file), "utf-8");
      expect(src).toContain("RouteErrorBoundary");
      expect(src).toContain(`source="${meta.source}"`);
      // No re-implemented boundary logic anywhere.
      expect(src).not.toContain("getRetryCount");
      expect(src).not.toContain("reportErrorToAnalytics");
      expect(src).not.toContain("buildIssueUrl");
      if (!meta.retryTracked) {
        expect(src).toContain("retryTracking={false}");
      } else {
        expect(src).not.toContain("retryTracking={false}");
      }
    });
  }

  it("retry-tracked wrappers provide the exhausted-retries copy", () => {
    for (const [file, meta] of Object.entries(ERROR_FILES)) {
      if (!meta.retryTracked) continue;
      const src = readFileSync(resolve(__dirname, file), "utf-8");
      expect(src).toContain("exhaustedMessage");
    }
  });
});

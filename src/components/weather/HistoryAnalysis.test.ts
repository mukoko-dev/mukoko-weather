import { describe, it, expect } from "vitest";

/**
 * HistoryAnalysis component tests.
 *
 * Tests focus on the component contract, AI analysis flow, and
 * architecture compliance (accessibility, ShamwariContext integration).
 */

describe("HistoryAnalysis", () => {
  it("exports HistoryAnalysis as a named export", async () => {
    const mod = await import("./HistoryAnalysis");
    expect(mod.HistoryAnalysis).toBeDefined();
    expect(typeof mod.HistoryAnalysis).toBe("function");
  });

  it("is a client component", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(__dirname, "HistoryAnalysis.tsx"), "utf-8");
    expect(source).toContain('"use client"');
  });

  it("calls the history analysis endpoint", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(__dirname, "HistoryAnalysis.tsx"), "utf-8");
    expect(source).toContain("/api/py/history/analyze");
  });

  it("includes location and days in request body", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(__dirname, "HistoryAnalysis.tsx"), "utf-8");
    expect(source).toContain("location: locationSlug");
    expect(source).toContain("days");
    expect(source).toContain("activities: selectedActivities");
  });

  it("uses MarkdownErrorBoundary for crash isolation", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(__dirname, "HistoryAnalysis.tsx"), "utf-8");
    expect(source).toContain("MarkdownErrorBoundary");
    expect(source).toContain("getDerivedStateFromError");
  });

  it("renders with aria-labelledby for accessibility", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(__dirname, "HistoryAnalysis.tsx"), "utf-8");
    expect(source).toContain('aria-labelledby="history-analysis-heading"');
    expect(source).toContain('id="history-analysis-heading"');
  });

  it("has 44px minimum touch targets on buttons", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(__dirname, "HistoryAnalysis.tsx"), "utf-8");
    expect(source).toContain("min-h-[44px]");
  });

  it("sets ShamwariContext for discuss-in-shamwari navigation", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(__dirname, "HistoryAnalysis.tsx"), "utf-8");
    expect(source).toContain("setShamwariContext");
    expect(source).toContain('source: "history"');
    expect(source).toContain("historyDays");
    expect(source).toContain("historyAnalysis");
  });

  it("uses tanzanite border for AI styling", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(__dirname, "HistoryAnalysis.tsx"), "utf-8");
    expect(source).toContain("border-mineral-tanzanite");
  });

  it("has a loading indicator with role=status", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(__dirname, "HistoryAnalysis.tsx"), "utf-8");
    expect(source).toContain('role="status"');
    expect(source).toContain("sr-only");
  });

  it("uses global styles only — no hardcoded colors", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const source = readFileSync(resolve(__dirname, "HistoryAnalysis.tsx"), "utf-8");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}[^)]/);
    expect(source).not.toContain("style={{");
  });
});

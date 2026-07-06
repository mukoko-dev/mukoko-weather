import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(resolve(__dirname, "ShamwariCTA.tsx"), "utf-8");

/**
 * ShamwariCTA — shared "continue this conversation in Shamwari" link.
 *
 * Centralizes the feature-flag gate + setShamwariContext handoff previously
 * hand-rolled separately in AISummaryChat, HistoryAnalysis, and ExploreSearch.
 */

describe("ShamwariCTA structure", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("exports ShamwariCTA", () => {
    expect(source).toContain("export function ShamwariCTA");
  });

  it("gates rendering behind the shamwari_chat feature flag", () => {
    expect(source).toContain('isFeatureEnabled("shamwari_chat")');
    expect(source).toContain("return null");
  });

  it("hands off context via setShamwariContext on click", () => {
    expect(source).toContain("setShamwariContext");
    expect(source).toContain('href="/shamwari"');
  });
});

describe("ShamwariCTA variants", () => {
  it("defines tanzanite, primary, subtle, and text variants", () => {
    expect(source).toContain("tanzanite:");
    expect(source).toContain("primary:");
    expect(source).toContain("subtle:");
    expect(source).toContain("text:");
  });

  it("supports both sparkles and map-pin icons", () => {
    expect(source).toContain("SparklesIcon");
    expect(source).toContain("MapPinIcon");
    expect(source).toContain('"map-pin"');
  });

  it("uses global styles only — no hardcoded colors", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}[^)]/);
    expect(source).not.toContain("style={{");
  });
});

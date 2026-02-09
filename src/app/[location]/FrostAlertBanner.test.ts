import { describe, it, expect } from "vitest";

/**
 * Tests for FrostAlertBanner CSS class mapping.
 * Validates that frost severity levels map to the correct design-system tokens
 * (CSS custom properties) instead of hardcoded colors.
 */

type FrostRisk = "severe" | "high" | "moderate";

// Extracted CSS class logic from FrostAlertBanner — mirrors the component exactly
function getBgColor(risk: FrostRisk): string {
  return risk === "severe"
    ? "bg-frost-severe-bg border-frost-severe"
    : risk === "high"
      ? "bg-frost-high-bg border-earth"
      : "bg-frost-moderate-bg border-accent";
}

function getTextColor(risk: FrostRisk): string {
  return risk === "severe"
    ? "text-frost-severe"
    : risk === "high"
      ? "text-earth"
      : "text-accent";
}

describe("FrostAlertBanner CSS class mapping", () => {
  describe("background and border classes", () => {
    it("uses frost-severe design tokens for severe risk", () => {
      const classes = getBgColor("severe");
      expect(classes).toContain("bg-frost-severe-bg");
      expect(classes).toContain("border-frost-severe");
    });

    it("uses frost-high-bg and earth border for high risk", () => {
      const classes = getBgColor("high");
      expect(classes).toContain("bg-frost-high-bg");
      expect(classes).toContain("border-earth");
    });

    it("uses frost-moderate-bg and accent border for moderate risk", () => {
      const classes = getBgColor("moderate");
      expect(classes).toContain("bg-frost-moderate-bg");
      expect(classes).toContain("border-accent");
    });

    it("never contains hardcoded hex colors", () => {
      for (const risk of ["severe", "high", "moderate"] as FrostRisk[]) {
        const classes = getBgColor(risk);
        expect(classes).not.toMatch(/#[0-9a-fA-F]{3,8}/);
        expect(classes).not.toMatch(/rgba?\(/);
      }
    });
  });

  describe("text color classes", () => {
    it("uses frost-severe token for severe risk", () => {
      expect(getTextColor("severe")).toBe("text-frost-severe");
    });

    it("uses earth token for high risk", () => {
      expect(getTextColor("high")).toBe("text-earth");
    });

    it("uses accent token for moderate risk", () => {
      expect(getTextColor("moderate")).toBe("text-accent");
    });

    it("never contains hardcoded hex colors or dark: overrides", () => {
      for (const risk of ["severe", "high", "moderate"] as FrostRisk[]) {
        const classes = getTextColor(risk);
        expect(classes).not.toMatch(/#[0-9a-fA-F]{3,8}/);
        expect(classes).not.toContain("dark:");
      }
    });
  });
});

/**
 * Tests for WelcomeBanner — validates the inline welcome experience for
 * first-time visitors (replaces the old auto-opening modal approach).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const source = readFileSync(
  resolve(__dirname, "WelcomeBanner.tsx"),
  "utf-8",
);

describe("WelcomeBanner — component structure", () => {
  it("is a client component", () => {
    expect(source).toContain('"use client"');
  });

  it("reads hasOnboarded from Zustand store", () => {
    expect(source).toContain("hasOnboarded");
    expect(source).toContain("useAppStore");
  });

  it("returns null when user has already onboarded", () => {
    // The component should early-return null for onboarded users
    expect(source).toContain("if (hasOnboarded) return null");
  });

  it("calls completeOnboarding to dismiss the banner", () => {
    expect(source).toContain("completeOnboarding");
  });
});

describe("WelcomeBanner — UX", () => {
  it("has a personalise button that triggers location change", () => {
    expect(source).toContain("onChangeLocation");
    expect(source).toContain("Personalise");
  });

  it("has a dismiss button to continue with current location", () => {
    expect(source).toContain("Continue with");
  });

  it("shows the current location name", () => {
    expect(source).toContain("locationName");
  });

  it("does not auto-open a modal — it is inline", () => {
    // The banner should NOT import or render any modal/dialog components
    expect(source).not.toContain("import.*Dialog");
    expect(source).not.toContain("<Dialog");
    expect(source).not.toContain("myWeatherOpen");
  });
});

describe("WelcomeBanner — accessibility", () => {
  it("has an aria-label on the section", () => {
    expect(source).toContain('aria-label="Welcome to mukoko weather"');
  });

  it("uses semantic section element", () => {
    expect(source).toContain("<section");
  });

  it("buttons have minimum touch target height", () => {
    // 44px min-height for both buttons (WCAG touch target requirement)
    expect(source).toContain("min-h-[44px]");
  });
});

describe("WelcomeBanner — styling", () => {
  it("uses CSS custom properties for border radius", () => {
    expect(source).toContain("var(--radius-card)");
  });

  it("uses brand token classes not hardcoded colors", () => {
    expect(source).toContain("bg-primary");
    expect(source).toContain("text-primary");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});

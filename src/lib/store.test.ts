import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveTheme, useAppStore, type ThemePreference } from "./store";

describe("resolveTheme", () => {
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    if (typeof window !== "undefined") {
      originalMatchMedia = window.matchMedia;
    }
  });

  afterEach(() => {
    // Restore original matchMedia
    if (typeof window !== "undefined" && originalMatchMedia) {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("returns 'light' for explicit light preference", () => {
    expect(resolveTheme("light")).toBe("light");
  });

  it("returns 'dark' for explicit dark preference", () => {
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("resolves 'system' to 'light' when window is not available (SSR)", () => {
    // In the Node test environment window is not defined,
    // so "system" falls back to "light"
    expect(resolveTheme("system")).toBe("light");
  });
});

describe("ThemePreference type", () => {
  it("accepts all valid theme preferences", () => {
    const prefs: ThemePreference[] = ["light", "dark", "system"];
    expect(prefs).toHaveLength(3);
    // Verify they round-trip through resolveTheme without error
    for (const pref of prefs) {
      const result = resolveTheme(pref);
      expect(["light", "dark"]).toContain(result);
    }
  });
});

describe("onboarding state", () => {
  it("defaults hasOnboarded to false", () => {
    const state = useAppStore.getState();
    expect(state.hasOnboarded).toBe(false);
  });

  it("sets hasOnboarded to true after completeOnboarding()", () => {
    useAppStore.getState().completeOnboarding();
    expect(useAppStore.getState().hasOnboarded).toBe(true);
  });
});

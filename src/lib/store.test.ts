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

describe("selectedLocation", () => {
  it("defaults to 'harare'", () => {
    const state = useAppStore.getState();
    expect(state.selectedLocation).toBe("harare");
  });

  it("updates via setSelectedLocation", () => {
    useAppStore.getState().setSelectedLocation("bulawayo");
    expect(useAppStore.getState().selectedLocation).toBe("bulawayo");
  });

  it("can be set to any slug string", () => {
    useAppStore.getState().setSelectedLocation("victoria-falls");
    expect(useAppStore.getState().selectedLocation).toBe("victoria-falls");
  });
});

describe("selectedActivities", () => {
  beforeEach(() => {
    // Reset activities to empty
    useAppStore.setState({ selectedActivities: [] });
  });

  it("defaults to an empty array", () => {
    expect(useAppStore.getState().selectedActivities).toEqual([]);
  });

  it("toggleActivity adds an activity when not present", () => {
    useAppStore.getState().toggleActivity("running");
    expect(useAppStore.getState().selectedActivities).toContain("running");
  });

  it("toggleActivity removes an activity when already present", () => {
    useAppStore.setState({ selectedActivities: ["running", "hiking"] });
    useAppStore.getState().toggleActivity("running");
    expect(useAppStore.getState().selectedActivities).not.toContain("running");
    expect(useAppStore.getState().selectedActivities).toContain("hiking");
  });

  it("can toggle multiple activities", () => {
    useAppStore.getState().toggleActivity("running");
    useAppStore.getState().toggleActivity("hiking");
    useAppStore.getState().toggleActivity("swimming");
    expect(useAppStore.getState().selectedActivities).toEqual([
      "running",
      "hiking",
      "swimming",
    ]);
  });

  it("toggling the same activity twice results in empty", () => {
    useAppStore.getState().toggleActivity("running");
    useAppStore.getState().toggleActivity("running");
    expect(useAppStore.getState().selectedActivities).toEqual([]);
  });
});

describe("myWeatherOpen", () => {
  it("defaults to false", () => {
    expect(useAppStore.getState().myWeatherOpen).toBe(false);
  });

  it("openMyWeather sets it to true", () => {
    useAppStore.getState().openMyWeather();
    expect(useAppStore.getState().myWeatherOpen).toBe(true);
  });

  it("closeMyWeather sets it back to false", () => {
    useAppStore.getState().openMyWeather();
    useAppStore.getState().closeMyWeather();
    expect(useAppStore.getState().myWeatherOpen).toBe(false);
  });
});

describe("theme actions", () => {
  it("setTheme updates the theme preference", () => {
    useAppStore.getState().setTheme("dark");
    expect(useAppStore.getState().theme).toBe("dark");

    useAppStore.getState().setTheme("light");
    expect(useAppStore.getState().theme).toBe("light");
  });

  it("toggleTheme cycles through light → dark → system", () => {
    useAppStore.getState().setTheme("light");

    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().theme).toBe("dark");

    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().theme).toBe("system");

    useAppStore.getState().toggleTheme();
    expect(useAppStore.getState().theme).toBe("light");
  });
});

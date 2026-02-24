import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveTheme, useAppStore, isShamwariContextValid, MAX_SAVED_LOCATIONS, type ThemePreference, type ShamwariContext } from "./store";

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

describe("savedLocations", () => {
  beforeEach(() => {
    useAppStore.setState({ savedLocations: [] });
  });

  it("defaults to an empty array", () => {
    expect(useAppStore.getState().savedLocations).toEqual([]);
  });

  it("saveLocation adds a slug", () => {
    useAppStore.getState().saveLocation("bulawayo");
    expect(useAppStore.getState().savedLocations).toEqual(["bulawayo"]);
  });

  it("saveLocation is a no-op when slug already saved", () => {
    useAppStore.setState({ savedLocations: ["bulawayo"] });
    useAppStore.getState().saveLocation("bulawayo");
    expect(useAppStore.getState().savedLocations).toEqual(["bulawayo"]);
  });

  it("saveLocation is a no-op at MAX_SAVED_LOCATIONS cap", () => {
    const full = Array.from({ length: MAX_SAVED_LOCATIONS }, (_, i) => `loc-${i}`);
    useAppStore.setState({ savedLocations: full });
    useAppStore.getState().saveLocation("one-more");
    expect(useAppStore.getState().savedLocations).toHaveLength(MAX_SAVED_LOCATIONS);
    expect(useAppStore.getState().savedLocations).not.toContain("one-more");
  });

  it("removeLocation removes an existing slug", () => {
    useAppStore.setState({ savedLocations: ["harare", "bulawayo", "mutare"] });
    useAppStore.getState().removeLocation("bulawayo");
    expect(useAppStore.getState().savedLocations).toEqual(["harare", "mutare"]);
  });

  it("removeLocation is a no-op for non-existent slug", () => {
    useAppStore.setState({ savedLocations: ["harare"] });
    useAppStore.getState().removeLocation("unknown");
    expect(useAppStore.getState().savedLocations).toEqual(["harare"]);
  });

  it("preserves order when adding multiple locations", () => {
    useAppStore.getState().saveLocation("harare");
    useAppStore.getState().saveLocation("bulawayo");
    useAppStore.getState().saveLocation("mutare");
    expect(useAppStore.getState().savedLocations).toEqual(["harare", "bulawayo", "mutare"]);
  });

  it("is persisted via partialize", () => {
    useAppStore.setState({ savedLocations: ["harare", "bulawayo"] });
    const state = useAppStore.getState();
    const persistApi = (useAppStore as unknown as { persist: { getOptions: () => { partialize?: (s: unknown) => unknown } } }).persist;
    if (persistApi?.getOptions?.()?.partialize) {
      const partialState = persistApi.getOptions().partialize!(state) as Record<string, unknown>;
      expect(partialState).toHaveProperty("savedLocations");
      expect(partialState.savedLocations).toEqual(["harare", "bulawayo"]);
    }
  });
});

describe("savedLocationsOpen", () => {
  it("defaults to false", () => {
    expect(useAppStore.getState().savedLocationsOpen).toBe(false);
  });

  it("openSavedLocations sets it to true", () => {
    useAppStore.getState().openSavedLocations();
    expect(useAppStore.getState().savedLocationsOpen).toBe(true);
  });

  it("closeSavedLocations sets it back to false", () => {
    useAppStore.getState().openSavedLocations();
    useAppStore.getState().closeSavedLocations();
    expect(useAppStore.getState().savedLocationsOpen).toBe(false);
  });

  it("is NOT persisted (excluded from partialize)", () => {
    useAppStore.getState().openSavedLocations();
    const state = useAppStore.getState();
    const persistApi = (useAppStore as unknown as { persist: { getOptions: () => { partialize?: (s: unknown) => unknown } } }).persist;
    if (persistApi?.getOptions?.()?.partialize) {
      const partialState = persistApi.getOptions().partialize!(state) as Record<string, unknown>;
      expect(partialState).not.toHaveProperty("savedLocationsOpen");
    }
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

describe("shamwariContext", () => {
  beforeEach(() => {
    useAppStore.setState({ shamwariContext: null });
  });

  it("defaults to null", () => {
    expect(useAppStore.getState().shamwariContext).toBeNull();
  });

  it("setShamwariContext stores context with auto-timestamp", () => {
    const ctx: Omit<ShamwariContext, "timestamp"> & { timestamp: number } = {
      source: "location",
      locationSlug: "harare",
      locationName: "Harare",
      weatherSummary: "Clear skies expected",
      temperature: 28,
      condition: "Clear",
      activities: ["running"],
      timestamp: 0,
    };
    useAppStore.getState().setShamwariContext(ctx);
    const stored = useAppStore.getState().shamwariContext;
    expect(stored).not.toBeNull();
    expect(stored!.locationSlug).toBe("harare");
    expect(stored!.timestamp).toBeGreaterThan(0);
  });

  it("clearShamwariContext resets to null", () => {
    useAppStore.getState().setShamwariContext({
      source: "location",
      activities: [],
      timestamp: Date.now(),
    });
    useAppStore.getState().clearShamwariContext();
    expect(useAppStore.getState().shamwariContext).toBeNull();
  });

  it("isShamwariContextValid returns false for null", () => {
    expect(isShamwariContextValid(null)).toBe(false);
  });

  it("isShamwariContextValid returns true for recent context", () => {
    const ctx: ShamwariContext = {
      source: "location",
      activities: [],
      timestamp: Date.now(),
    };
    expect(isShamwariContextValid(ctx)).toBe(true);
  });

  it("isShamwariContextValid returns false for expired context (>10 min)", () => {
    const ctx: ShamwariContext = {
      source: "location",
      activities: [],
      timestamp: Date.now() - 11 * 60 * 1000,
    };
    expect(isShamwariContextValid(ctx)).toBe(false);
  });

  it("is NOT persisted (excluded from partialize)", () => {
    // Set context
    useAppStore.getState().setShamwariContext({
      source: "history",
      locationSlug: "bulawayo",
      activities: ["hiking"],
      timestamp: Date.now(),
    });
    // partialize only includes theme, selectedLocation, selectedActivities, hasOnboarded
    // shamwariContext should NOT be in the serialized output
    const state = useAppStore.getState();
    // Access the persist API to check partialize
    const persistApi = (useAppStore as unknown as { persist: { getOptions: () => { partialize?: (s: unknown) => unknown } } }).persist;
    if (persistApi?.getOptions?.()?.partialize) {
      const partialState = persistApi.getOptions().partialize!(state) as Record<string, unknown>;
      expect(partialState).not.toHaveProperty("shamwariContext");
      expect(partialState).not.toHaveProperty("reportModalOpen");
    }
  });
});

describe("reportModal", () => {
  it("defaults to closed", () => {
    expect(useAppStore.getState().reportModalOpen).toBe(false);
  });

  it("openReportModal sets it to true", () => {
    useAppStore.getState().openReportModal();
    expect(useAppStore.getState().reportModalOpen).toBe(true);
  });

  it("closeReportModal sets it back to false", () => {
    useAppStore.getState().openReportModal();
    useAppStore.getState().closeReportModal();
    expect(useAppStore.getState().reportModalOpen).toBe(false);
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

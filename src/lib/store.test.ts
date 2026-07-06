import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resolveTheme, useAppStore, isShamwariContextValid, MAX_SAVED_LOCATIONS, DEFAULT_SECTION_ORDER, mergeSectionOrder, type ThemePreference, type ShamwariContext } from "./store";

// Mock RxDB bridge to prevent IndexedDB access in tests
vi.mock("./rxdb/bridge", () => ({
  updatePreferences: vi.fn(),
  initRxDBBridge: vi.fn().mockResolvedValue(undefined),
  getDeviceId: () => "test-device-id",
  migrateLocalStorageToRxDB: vi.fn().mockResolvedValue(undefined),
  _resetBridge: vi.fn(),
}));

vi.mock("./rxdb/replication", () => ({
  startReplication: vi.fn().mockResolvedValue(undefined),
  stopReplication: vi.fn().mockResolvedValue(undefined),
}));

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
  it("defaults to empty string", () => {
    const state = useAppStore.getState();
    expect(state.selectedLocation).toBe("");
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

  it("saveLocation triggers RxDB persistence", async () => {
    const { updatePreferences } = await import("./rxdb/bridge");
    vi.mocked(updatePreferences).mockClear();
    useAppStore.getState().saveLocation("gweru");
    expect(updatePreferences).toHaveBeenCalledWith(
      expect.objectContaining({ savedLocations: expect.arrayContaining(["gweru"]) }),
    );
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

  it("is NOT persisted to RxDB (transient state)", async () => {
    const { updatePreferences } = await import("./rxdb/bridge");
    vi.mocked(updatePreferences).mockClear();
    useAppStore.getState().openSavedLocations();
    // Transient state should NOT trigger RxDB persistence
    expect(updatePreferences).not.toHaveBeenCalled();
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

  it("is NOT persisted to RxDB (transient state)", async () => {
    const { updatePreferences } = await import("./rxdb/bridge");
    vi.mocked(updatePreferences).mockClear();
    useAppStore.getState().setShamwariContext({
      source: "history",
      locationSlug: "bulawayo",
      activities: ["hiking"],
      timestamp: Date.now(),
    });
    // Transient state should NOT trigger RxDB persistence
    expect(updatePreferences).not.toHaveBeenCalled();
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

describe("locationLabels", () => {
  beforeEach(() => {
    useAppStore.setState({ locationLabels: {}, savedLocations: [] });
  });

  it("defaults to an empty object", () => {
    expect(useAppStore.getState().locationLabels).toEqual({});
  });

  it("setLocationLabel adds a label for a slug", () => {
    useAppStore.getState().setLocationLabel("harare", "Home");
    expect(useAppStore.getState().locationLabels).toEqual({ harare: "Home" });
  });

  it("setLocationLabel removes a label when set to empty string", () => {
    useAppStore.setState({ locationLabels: { harare: "Home" } });
    useAppStore.getState().setLocationLabel("harare", "");
    expect(useAppStore.getState().locationLabels).toEqual({});
  });

  it("setLocationLabel trims whitespace", () => {
    useAppStore.getState().setLocationLabel("harare", "  My Home  ");
    expect(useAppStore.getState().locationLabels).toEqual({ harare: "My Home" });
  });

  it("removeLocation also cleans up the label", () => {
    useAppStore.setState({
      savedLocations: ["harare", "bulawayo"],
      locationLabels: { harare: "Home", bulawayo: "Work" },
    });
    useAppStore.getState().removeLocation("harare");
    expect(useAppStore.getState().locationLabels).toEqual({ bulawayo: "Work" });
  });

  it("setLocationLabel triggers RxDB persistence", async () => {
    const { updatePreferences } = await import("./rxdb/bridge");
    vi.mocked(updatePreferences).mockClear();
    useAppStore.getState().setLocationLabel("harare", "Home");
    expect(updatePreferences).toHaveBeenCalledWith(
      expect.objectContaining({ locationLabels: { harare: "Home" } }),
    );
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

describe("sectionOrder", () => {
  it("has a default section order with all expected sections", () => {
    const { sectionOrder } = useAppStore.getState();
    expect(sectionOrder).toContain("hourlyScroll");
    expect(sectionOrder).toContain("current");
    expect(sectionOrder).toContain("atmospheric");
    expect(sectionOrder).toContain("activityInsights");
    expect(sectionOrder).toContain("aiSummary");
    expect(sectionOrder.length).toBeGreaterThan(5);
  });

  it("does not include hourlyForecast/dailyForecast — full detail lives on /forecast only", () => {
    // These duplicated /forecast's HourlyForecast/DailyForecast charts
    // verbatim on the main page. HourlyScrollCards (always present) is the
    // main-page preview; full detail is a deliberate navigation to /forecast.
    const { sectionOrder } = useAppStore.getState();
    expect(sectionOrder).not.toContain("hourlyForecast");
    expect(sectionOrder).not.toContain("dailyForecast");
  });

  it("puts the current-conditions hero first, before the hourly scroll strip", () => {
    // The main current-conditions card is the page hero and must render at the
    // very top of the primary column, above HourlyScrollCards.
    const currentIdx = DEFAULT_SECTION_ORDER.indexOf("current");
    const hourlyIdx = DEFAULT_SECTION_ORDER.indexOf("hourlyScroll");
    expect(currentIdx).toBe(0);
    expect(currentIdx).toBeLessThan(hourlyIdx);
  });

  it("setSectionOrder updates the order", () => {
    const newOrder = ["current", "hourlyScroll", "atmospheric"];
    useAppStore.getState().setSectionOrder(newOrder);
    expect(useAppStore.getState().sectionOrder).toEqual(newOrder);
  });

  it("setSectionOrder accepts any string array", () => {
    // localStorage is not available in Node test environment — only test store state
    const custom = ["atmospheric", "current", "aiSummary"];
    useAppStore.getState().setSectionOrder(custom);
    expect(useAppStore.getState().sectionOrder).toEqual(custom);
  });

  it("initialises to DEFAULT_SECTION_ORDER (hydration-safe — no synchronous localStorage read)", () => {
    // The store must init to the defaults on both the server and the first client
    // render so React hydration matches. Persisted order is applied post-hydration.
    // Re-import a fresh module to observe the initial value (setSectionOrder in the
    // tests above mutates the shared singleton), so assert the exported default here.
    expect([...DEFAULT_SECTION_ORDER]).toEqual([
      "current",
      "hourlyScroll",
      "atmospheric",
      "reports",
      "activityInsights",
      "aiSummary",
      "aiChat",
    ]);
  });

  it("hydrateSectionOrder is a safe no-op when localStorage is unavailable (SSR/Node)", () => {
    const before = useAppStore.getState().sectionOrder;
    expect(() => useAppStore.getState().hydrateSectionOrder()).not.toThrow();
    // No window/localStorage in Node → order left untouched.
    expect(useAppStore.getState().sectionOrder).toEqual(before);
  });
});

describe("mergeSectionOrder (Bug 2 — union stored order with defaults)", () => {
  it("appends sections added AFTER a user saved their order, at their default position", () => {
    // A legacy user saved before hourlyScroll/reports/aiChat existed.
    const stored = ["current", "atmospheric", "activityInsights", "aiSummary"];
    const merged = mergeSectionOrder(stored);
    // Every default section is now present...
    for (const id of DEFAULT_SECTION_ORDER) expect(merged).toContain(id);
    // ...and the new ids landed near their default neighbours.
    expect(merged).toEqual([
      "current",
      "hourlyScroll",
      "atmospheric",
      "reports",
      "activityInsights",
      "aiSummary",
      "aiChat",
    ]);
  });

  it("drops ids that are no longer part of DEFAULT_SECTION_ORDER", () => {
    const stored = ["current", "legacyRemovedSection", "atmospheric"];
    const merged = mergeSectionOrder(stored);
    expect(merged).not.toContain("legacyRemovedSection");
    expect(merged).toContain("current");
    expect(merged).toContain("atmospheric");
  });

  it("drops the removed hourlyForecast/dailyForecast ids from a pre-existing stored order", () => {
    // Users who customised their layout before these sections were removed
    // (full detail moved exclusively to /forecast) have them lingering in
    // localStorage — must disappear silently, not error or leave a gap.
    const stored = [
      "current",
      "hourlyScroll",
      "atmospheric",
      "reports",
      "hourlyForecast",
      "activityInsights",
      "dailyForecast",
      "aiSummary",
      "aiChat",
    ];
    const merged = mergeSectionOrder(stored);
    expect(merged).not.toContain("hourlyForecast");
    expect(merged).not.toContain("dailyForecast");
    expect(merged).toEqual([...DEFAULT_SECTION_ORDER]);
  });

  it("preserves the user's custom ordering of the sections they DID arrange", () => {
    // User moved atmospheric above current and dropped nothing else.
    const stored = [
      "atmospheric",
      "current",
      "hourlyScroll",
      "reports",
      "activityInsights",
      "aiSummary",
      "aiChat",
    ];
    const merged = mergeSectionOrder(stored);
    expect(merged.indexOf("atmospheric")).toBeLessThan(merged.indexOf("current"));
    expect(merged).toHaveLength(DEFAULT_SECTION_ORDER.length);
  });

  it("de-dupes repeated ids", () => {
    const merged = mergeSectionOrder(["current", "current", "atmospheric"]);
    expect(merged.filter((id) => id === "current")).toHaveLength(1);
  });

  it("returns the full default set for an empty stored array", () => {
    expect(mergeSectionOrder([])).toEqual([...DEFAULT_SECTION_ORDER]);
  });
});

describe("selectedForecastModel", () => {
  it("defaults to best_match", () => {
    expect(useAppStore.getState().selectedForecastModel).toBe("best_match");
  });

  it("setSelectedForecastModel updates state", () => {
    useAppStore.getState().setSelectedForecastModel("ecmwf_ifs04");
    expect(useAppStore.getState().selectedForecastModel).toBe("ecmwf_ifs04");
    // reset for other tests
    useAppStore.getState().setSelectedForecastModel("best_match");
  });
});

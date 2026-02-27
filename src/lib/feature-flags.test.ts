import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  FLAGS,
  isFeatureEnabled,
  isFeatureEnabledWithOverride,
  getFeatureFlag,
  type FeatureFlag,
} from "./feature-flags";

// ---------------------------------------------------------------------------
// Mock localStorage (Vitest runs in Node — no native localStorage or window)
// ---------------------------------------------------------------------------

const createLocalStorageMock = () => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
};

const localStorageMock = createLocalStorageMock();
Object.defineProperty(globalThis, "localStorage", { value: localStorageMock, writable: true });

describe("feature-flags", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let originalWindow: any;

  beforeEach(() => {
    originalWindow = globalThis.window;
    localStorageMock.clear();
    // Simulate browser environment so typeof window !== "undefined"
    // @ts-expect-error — minimal window mock
    globalThis.window = globalThis;
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      // @ts-expect-error — restoring undefined
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  });

  describe("FLAGS", () => {
    it("defines all expected feature flags", () => {
      const expectedFlags: FeatureFlag[] = [
        "weather_reports",
        "ai_summary_chat",
        "explore_search",
        "history_analysis",
        "shamwari_chat",
        "map_layers",
        "premium_maps",
        "vector_search",
        "multi_language",
      ];
      expect(Object.keys(FLAGS)).toEqual(expect.arrayContaining(expectedFlags));
      expect(Object.keys(FLAGS)).toHaveLength(expectedFlags.length);
    });

    it("has all current features enabled by default", () => {
      expect(FLAGS.weather_reports).toBe(true);
      expect(FLAGS.ai_summary_chat).toBe(true);
      expect(FLAGS.explore_search).toBe(true);
      expect(FLAGS.history_analysis).toBe(true);
      expect(FLAGS.shamwari_chat).toBe(true);
      expect(FLAGS.map_layers).toBe(true);
    });

    it("has experimental/future features disabled by default", () => {
      expect(FLAGS.premium_maps).toBe(false);
      expect(FLAGS.vector_search).toBe(false);
      expect(FLAGS.multi_language).toBe(false);
    });
  });

  describe("isFeatureEnabled", () => {
    it("returns true for enabled flags", () => {
      expect(isFeatureEnabled("weather_reports")).toBe(true);
      expect(isFeatureEnabled("map_layers")).toBe(true);
    });

    it("returns false for disabled flags", () => {
      expect(isFeatureEnabled("premium_maps")).toBe(false);
      expect(isFeatureEnabled("vector_search")).toBe(false);
    });

    it("does NOT check localStorage overrides", () => {
      localStorageMock.setItem("ff:premium_maps", "true");
      expect(isFeatureEnabled("premium_maps")).toBe(false);
    });
  });

  describe("isFeatureEnabledWithOverride", () => {
    afterEach(() => {
      localStorageMock.clear();
    });

    it("returns default value when no override exists", () => {
      expect(isFeatureEnabledWithOverride("weather_reports")).toBe(true);
      expect(isFeatureEnabledWithOverride("premium_maps")).toBe(false);
    });

    it("returns true when localStorage override is 'true'", () => {
      localStorageMock.setItem("ff:premium_maps", "true");
      expect(isFeatureEnabledWithOverride("premium_maps")).toBe(true);
    });

    it("returns false when localStorage override is 'false'", () => {
      localStorageMock.setItem("ff:weather_reports", "false");
      expect(isFeatureEnabledWithOverride("weather_reports")).toBe(false);
    });

    it("ignores invalid localStorage values and uses default", () => {
      localStorageMock.setItem("ff:premium_maps", "yes");
      expect(isFeatureEnabledWithOverride("premium_maps")).toBe(false);

      localStorageMock.setItem("ff:weather_reports", "0");
      expect(isFeatureEnabledWithOverride("weather_reports")).toBe(true);
    });

    it("handles localStorage errors gracefully", () => {
      // Temporarily replace localStorage with a throwing mock
      const throwingStorage = {
        getItem: () => { throw new Error("QuotaExceededError"); },
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
      };
      const savedLS = globalThis.localStorage;
      Object.defineProperty(globalThis, "localStorage", { value: throwingStorage, writable: true });

      // Should fall back to default, not throw
      expect(isFeatureEnabledWithOverride("premium_maps")).toBe(false);
      expect(isFeatureEnabledWithOverride("weather_reports")).toBe(true);

      // Restore normal localStorage
      Object.defineProperty(globalThis, "localStorage", { value: savedLS, writable: true });
    });

    it("falls back to default on server (window undefined)", () => {
      // @ts-expect-error — simulate SSR
      delete globalThis.window;

      expect(isFeatureEnabledWithOverride("premium_maps")).toBe(false);
      expect(isFeatureEnabledWithOverride("weather_reports")).toBe(true);

      // Restore window for afterEach
      // @ts-expect-error — minimal window mock
      globalThis.window = globalThis;
    });
  });

  describe("getFeatureFlag", () => {
    beforeEach(() => {
      localStorageMock.clear();
    });

    it("returns default flag value", () => {
      expect(getFeatureFlag("weather_reports")).toBe(true);
      expect(getFeatureFlag("premium_maps")).toBe(false);
    });

    it("respects localStorage overrides", () => {
      localStorageMock.setItem("ff:premium_maps", "true");
      expect(getFeatureFlag("premium_maps")).toBe(true);
    });

    it("is equivalent to isFeatureEnabledWithOverride for a given flag", () => {
      // Test a representative flag (not in a loop to satisfy react-hooks/rules-of-hooks)
      expect(getFeatureFlag("weather_reports")).toBe(isFeatureEnabledWithOverride("weather_reports"));
      expect(getFeatureFlag("premium_maps")).toBe(isFeatureEnabledWithOverride("premium_maps"));
    });
  });
});

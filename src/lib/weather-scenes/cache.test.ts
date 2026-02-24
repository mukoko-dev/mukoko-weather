import { describe, it, expect, beforeEach, vi } from "vitest";
import type { CachedWeatherHint } from "./types";

// Mock localStorage for Node test environment (with length/key for eviction)
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();
Object.defineProperty(globalThis, "localStorage", { value: localStorageMock, writable: true });

// Import after localStorage is mocked
const { cacheWeatherHint, getCachedWeatherHint } = await import("./cache");

describe("weather hint cache", () => {
  beforeEach(() => {
    localStorageMock.clear();
  });

  const hint: CachedWeatherHint = {
    weatherCode: 63,
    isDay: true,
    temperature: 22,
    windSpeed: 15,
    timestamp: Date.now(),
  };

  it("writes and reads back a hint", () => {
    cacheWeatherHint("harare", hint);
    const result = getCachedWeatherHint("harare");
    expect(result).toEqual(hint);
  });

  it("returns null for missing slug", () => {
    expect(getCachedWeatherHint("nonexistent")).toBeNull();
  });

  it("returns null for expired hint (>2h)", () => {
    const expired: CachedWeatherHint = {
      ...hint,
      timestamp: Date.now() - 3 * 60 * 60 * 1000, // 3 hours ago
    };
    cacheWeatherHint("harare", expired);
    expect(getCachedWeatherHint("harare")).toBeNull();
  });

  it("removes expired entry from localStorage", () => {
    const expired: CachedWeatherHint = {
      ...hint,
      timestamp: Date.now() - 3 * 60 * 60 * 1000,
    };
    cacheWeatherHint("harare", expired);
    getCachedWeatherHint("harare");
    expect(localStorageMock.getItem("mukoko-weather-hint:harare")).toBeNull();
  });

  it("returns valid hint that is under 2h old", () => {
    const recent: CachedWeatherHint = {
      ...hint,
      timestamp: Date.now() - 60 * 60 * 1000, // 1 hour ago
    };
    cacheWeatherHint("bulawayo", recent);
    expect(getCachedWeatherHint("bulawayo")).toEqual(recent);
  });

  it("handles localStorage getItem throwing", () => {
    const original = localStorageMock.getItem;
    localStorageMock.getItem = () => { throw new Error("quota exceeded"); };
    expect(getCachedWeatherHint("harare")).toBeNull();
    localStorageMock.getItem = original;
  });

  it("handles localStorage setItem throwing", () => {
    const original = localStorageMock.setItem;
    localStorageMock.setItem = () => { throw new Error("quota exceeded"); };
    expect(() => cacheWeatherHint("harare", hint)).not.toThrow();
    localStorageMock.setItem = original;
  });

  it("handles malformed JSON gracefully", () => {
    localStorageMock.setItem("mukoko-weather-hint:harare", "not-json");
    expect(getCachedWeatherHint("harare")).toBeNull();
  });

  it("returns null and removes entry with wrong shape (missing timestamp)", () => {
    localStorageMock.setItem("mukoko-weather-hint:harare", JSON.stringify({ weatherCode: 1 }));
    expect(getCachedWeatherHint("harare")).toBeNull();
    expect(localStorageMock.getItem("mukoko-weather-hint:harare")).toBeNull();
  });

  it("returns null and removes entry that is a JSON primitive", () => {
    localStorageMock.setItem("mukoko-weather-hint:harare", JSON.stringify(42));
    expect(getCachedWeatherHint("harare")).toBeNull();
    expect(localStorageMock.getItem("mukoko-weather-hint:harare")).toBeNull();
  });

  it("evicts oldest entries when exceeding 50 cached locations", () => {
    // Fill cache with 51 entries — oldest should be evicted
    for (let i = 0; i < 51; i++) {
      const h: CachedWeatherHint = {
        ...hint,
        timestamp: Date.now() - (51 - i) * 1000, // oldest first
      };
      cacheWeatherHint(`location-${i}`, h);
    }

    // The oldest entry (location-0) should have been evicted
    expect(localStorageMock.getItem("mukoko-weather-hint:location-0")).toBeNull();
    // Recent entries should still exist
    expect(localStorageMock.getItem("mukoko-weather-hint:location-50")).not.toBeNull();
  });

  it("does not evict when under 50 entries", () => {
    for (let i = 0; i < 10; i++) {
      cacheWeatherHint(`location-${i}`, hint);
    }
    // All 10 should still exist
    for (let i = 0; i < 10; i++) {
      expect(localStorageMock.getItem(`mukoko-weather-hint:location-${i}`)).not.toBeNull();
    }
  });

  it("ignores non-hint localStorage keys during eviction", () => {
    localStorageMock.setItem("unrelated-key", "some-data");
    for (let i = 0; i < 51; i++) {
      cacheWeatherHint(`loc-${i}`, { ...hint, timestamp: Date.now() - (51 - i) * 1000 });
    }
    // Unrelated key should not be touched
    expect(localStorageMock.getItem("unrelated-key")).toBe("some-data");
  });

  it("skips full eviction scan when under MAX_ENTRIES (early exit)", () => {
    // Write 5 entries — well under 50 cap
    for (let i = 0; i < 5; i++) {
      cacheWeatherHint(`fast-${i}`, hint);
    }
    // Spy on removeItem — should not be called for eviction
    const removeSpy = vi.spyOn(localStorageMock, "removeItem");
    cacheWeatherHint("fast-trigger", hint);
    expect(removeSpy).not.toHaveBeenCalled();
    removeSpy.mockRestore();
  });
});
